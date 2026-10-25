import { randomUUID } from "node:crypto";

import type { Db } from "@/db/client";
import { readSessionCookie } from "@/lib/auth/cookies";
import { isSameOrigin, jsonError, routeError } from "@/lib/auth/http";
import { findSession } from "@/lib/auth/service";
import { getRuntimeConfig } from "@/lib/settings/runtime";
import { readmeSourceUrl } from "@/lib/readme/source";
import { assetUrl } from "@/lib/storage/urls";
import type { VersionSummary } from "@/lib/products/version-summary";
import { isCategoryKey } from "@/lib/products/taxonomy";
import { recomputeProductLatestVersions } from "@/lib/products/latest";
import { enforceChannelLimit } from "@/lib/ratelimit/enforce";
import { recordAudit, recordModerationEvent } from "@/lib/moderation/events";
import {
  delistProduct as delistProductRow,
  findAssetBySha256,
  findOwnedProduct,
  findProductIdByExtensionId,
  findProductIdBySlug,
  findRepoFullName,
  findTranslation,
  findVersionWithProduct,
  getProductReadme,
  insertProduct,
  listLatestRejectionReasons,
  listProductsByOwner,
  listVersionRowsForProduct,
  updateProductReviewState,
  updateReleaseVersionState,
  updateProductFields,
  upsertTranslation,
  type AssetRow,
  type DbExecutor,
  type ProductRow,
  type ReadmeRow,
  type TranslationRow,
} from "./store";
import { EMPTY_VERSION_SUMMARY, listProductVersionSummaries } from "./summary";
import type {
  DashboardBrand,
  DashboardProduct,
  DashboardProductDetail,
  DashboardReadme,
  ProductKind,
  ProductPatch,
} from "./types";

/**
 * Product business rules: identity of a draft, slug resolution, ownership (404, never
 * 403) and copy normalization. Media and introduction are not decided here — the icon comes
 * from GitHub's social preview and the introduction is the repository README, both fetched
 * elsewhere. HTTP shaping lives in the route handlers; all SQL lives in `store.ts`.
 */

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LOCALE = "zh-CN";
const MAX_NAME_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 300;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;
const SLUG_ATTEMPTS = 50;

export class ProductError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.name = "ProductError";
    this.code = code;
    this.status = status;
  }
}

export function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function productErrorResponse(error: unknown): Response {
  if (error instanceof ProductError) {
    return jsonError(error.code, error.status, error.message);
  }
  // ConfigError / unknown failures: the shared handler logs and returns a bare 500.
  return routeError(error);
}

// ---------------------------------------------------------------------------
// Dashboard request guard
// ---------------------------------------------------------------------------

export type DashboardAuth =
  | { ok: true; accountId: string }
  | { ok: false; response: Response };

export type DashboardSession = { accountId: string };

/**
 * The access decision, free of IO so it can be tested without a Next request scope.
 * CSRF comes first for mutations (a cross-origin POST is rejected before the session
 * is looked at); anonymous callers always get 401.
 */
export function evaluateDashboardAccess(input: {
  request: Request;
  publicUrl: string;
  session: DashboardSession | null;
  mutation: boolean;
}): DashboardAuth {
  if (input.mutation && !isSameOrigin(input.request, input.publicUrl)) {
    return { ok: false, response: jsonError("cross_origin", 403) };
  }
  if (!input.session) {
    return { ok: false, response: jsonError("unauthenticated", 401) };
  }
  return { ok: true, accountId: input.session.accountId };
}

export async function authorizeDashboardRequest(
  db: Db,
  request: Request,
  options: { mutation: boolean },
): Promise<DashboardAuth> {
  const { publicUrl } = await getRuntimeConfig(db);
  const token = await readSessionCookie();
  const session = token ? await findSession(db, token) : null;
  const access = evaluateDashboardAccess({
    request,
    publicUrl,
    session: session ? { accountId: session.account.id } : null,
    mutation: options.mutation,
  });
  if (!access.ok) return access;

  // Writes only: browsing the dashboard must not consume the submit budget.
  if (options.mutation) {
    const limited = await enforceChannelLimit(
      db,
      "submit",
      `submit:account:${access.accountId}`,
    );
    if (limited) return { ok: false, response: limited };
  }
  return access;
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

export type CreateProductInput = {
  accountId: string;
  extensionId: string;
  name: string;
  kind: ProductKind;
  slug?: string | null;
  category?: string | null;
  tags?: string[];
  locale?: string;
  summary?: string;
};

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProductError("invalid_body", 400);
  }
  return body as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      throw new ProductError(`invalid_${key.replace(/_/g, "")}`, 400);
    }
    return value;
  }
  return undefined;
}

/** `null` means "clear" for nullable columns; absence means "leave alone". */
function readNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ProductError("invalid_category", 400);
  return value;
}

function readTags(record: Record<string, unknown>): string[] | undefined {
  if (!("tags" in record) || record.tags === undefined) return undefined;
  const value = record.tags;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new ProductError("invalid_tags", 400);
  }
  return value as string[];
}

export function parseCreateProductInput(
  body: unknown,
  accountId: string,
): CreateProductInput {
  const record = asRecord(body);

  const extensionId = readString(record, "extensionId", "extension_id");
  if (extensionId === undefined) {
    throw new ProductError("invalid_extension_id", 400);
  }
  const name = readString(record, "name");
  if (name === undefined) throw new ProductError("invalid_name", 400);
  const kind = readString(record, "kind");
  if (kind !== "plugin" && kind !== "theme") {
    throw new ProductError("invalid_kind", 400);
  }

  const input: CreateProductInput = {
    accountId,
    extensionId,
    name,
    kind,
  };

  const slug = readNullableString(record, "slug");
  if (slug !== undefined) input.slug = slug;
  const category = readNullableString(record, "category");
  if (category !== undefined) input.category = category;
  const tags = readTags(record);
  if (tags !== undefined) input.tags = tags;

  const locale = readString(record, "locale", "defaultLocale", "default_locale");
  if (locale !== undefined) input.locale = locale;
  const summary = readString(record, "summary");
  if (summary !== undefined) input.summary = summary;

  return input;
}

/**
 * Columns a PATCH may never touch.
 *
 * `name` and `descriptionMd` joined this list when the product became GitHub-sourced: the
 * name comes from the extension manifest and the introduction comes from the README, so a
 * request that tries to set either is a stale client, not a feature request.
 */
const NON_EDITABLE_FIELDS = [
  "status",
  "owner_account_id",
  "ownerAccountId",
  "repo_id",
  "repoId",
  "extension_id",
  "extensionId",
  "name",
  "descriptionMd",
  "description_md",
  "defaultLocale",
  "default_locale",
];

export function parseProductPatch(body: unknown): ProductPatch {
  const record = asRecord(body);
  for (const field of NON_EDITABLE_FIELDS) {
    if (field in record) {
      throw new ProductError(
        "field_not_editable",
        400,
        `${field} is not editable through this endpoint`,
      );
    }
  }

  const patch: ProductPatch = {};
  const summary = readString(record, "summary");
  if (summary !== undefined) patch.summary = summary;
  const category = readNullableString(record, "category");
  if (category !== undefined) patch.category = category;
  const tags = readTags(record);
  if (tags !== undefined) patch.tags = tags;

  return patch;
}

// ---------------------------------------------------------------------------
// Normalizing and sanitizing
// ---------------------------------------------------------------------------

const HTML_COMMENTS = /<!--[\s\S]*?-->/g;
const BLOCK_ELEMENTS = /<(script|style|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const STRAY_BLOCK_TAGS = /<\/?(script|style|svg|iframe)\b[^>]*>?/gi;
const ANY_TAG = /<\/?[a-zA-Z][^>]*>/g;

/**
 * Descriptions and summaries are stored as plain text: the block elements that would
 * execute or embed anything are removed with their content, then every remaining tag
 * is stripped. Entities are deliberately NOT decoded - the stored value is text, so a
 * second escape downstream stays correct.
 */
export function sanitizeText(input: string): string {
  return input
    .replace(HTML_COMMENTS, "")
    .replace(BLOCK_ELEMENTS, "")
    .replace(STRAY_BLOCK_TAGS, "")
    .replace(ANY_TAG, "")
    .trim();
}

function sanitizeBounded(
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > max) {
    throw new ProductError("text_too_long", 400, `text exceeds ${max} characters`);
  }
  return sanitizeText(value);
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new ProductError("invalid_name", 400);
  }
  return name;
}

function normalizeCategory(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const category = value.trim();
  if (!category) return null;
  if (!isCategoryKey(category)) {
    throw new ProductError("invalid_category", 400);
  }
  return category;
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH) {
      throw new ProductError("invalid_tags", 400);
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  if (normalized.length > MAX_TAGS) {
    throw new ProductError("invalid_tags", 400, `at most ${MAX_TAGS} tags`);
  }
  return normalized;
}

function normalizeLocale(value: string | null | undefined): string {
  if (value === undefined || value === null) return DEFAULT_LOCALE;
  const locale = value.trim();
  if (!locale) return DEFAULT_LOCALE;
  if (!LOCALE_PATTERN.test(locale)) {
    throw new ProductError("invalid_locale", 400);
  }
  return locale;
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function slugifyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function slugWithSuffix(base: string, index: number): string {
  const suffix = `-${index}`;
  const head = base.slice(0, 64 - suffix.length).replace(/-+$/g, "");
  return `${head}${suffix}`;
}

async function resolveSlug(
  db: DbExecutor,
  input: { name: string; id: string; slug?: string | null },
): Promise<string> {
  if (input.slug !== undefined && input.slug !== null) {
    const slug = input.slug.trim();
    if (!SLUG_PATTERN.test(slug)) throw new ProductError("invalid_slug", 400);
    if (await findProductIdBySlug(db, slug)) {
      throw new ProductError("slug_taken", 409);
    }
    return slug;
  }

  const derived = slugifyName(input.name);
  const base = SLUG_PATTERN.test(derived) ? derived : `ext-${input.id.slice(0, 8)}`;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : slugWithSuffix(base, attempt + 1);
    if (!(await findProductIdBySlug(db, candidate))) return candidate;
  }
  throw new ProductError("slug_taken", 409);
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toDashboardProduct(
  product: ProductRow,
  previewSha256: string | null,
  reviewReason: string | null = null,
): DashboardProduct {
  return {
    id: product.id,
    slug: product.slug,
    extensionId: product.extensionId,
    name: product.name,
    kind: product.kind,
    status: product.status,
    category: product.category,
    tags: product.tags,
    previewUrl: previewSha256 ? assetUrl(previewSha256) : null,
    repoId: product.repoId,
    reviewReason,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

/**
 * The dashboard shows the cached README with its provenance. `sourceUrl` is rebuilt from the
 * current binding rather than stored, so a rebind cannot leave a link pointing at the old
 * repository.
 */
function toDashboardReadme(
  row: ReadmeRow | null,
  repoFullName: string | null,
): DashboardReadme | null {
  if (!row) return null;
  return {
    path: row.path,
    sourceUrl:
      repoFullName === null
        ? `https://github.com`
        : readmeSourceUrl(repoFullName, row.path, row.ref),
    blobSha: row.blobSha,
    fetchedAt: row.fetchedAt.toISOString(),
    byteSize: row.byteSize,
    html: row.html,
    fetchError: row.fetchError,
  };
}

/**
 * The brand slots as the dashboard shows them. The URLs are rebuilt from the digests rather
 * than stored, for the same reason the README link is: a URL cannot go stale behind a row.
 */
function toDashboardBrand(product: ProductRow): DashboardBrand {
  return {
    icon: {
      url: product.previewSha256 ? assetUrl(product.previewSha256) : null,
      sha256: product.previewSha256,
      source: product.previewSource ?? null,
      fetchedAt: product.previewFetchedAt?.toISOString() ?? null,
      note: product.previewNote,
      error: product.previewError,
    },
    social: {
      url: product.ogSha256 ? assetUrl(product.ogSha256) : null,
      sha256: product.ogSha256,
      fetchedAt: product.ogFetchedAt?.toISOString() ?? null,
      error: product.ogError,
    },
  };
}

function toDetail(input: {
  product: Parameters<typeof toDashboardProduct>[0];
  previewSha256: string | null;
  defaultLocale: string;
  translation: TranslationRow | null;
  readme: DashboardReadme | null;
  versions: Awaited<ReturnType<typeof listVersionRowsForProduct>>;
  reviewReason: string | null;
}): DashboardProductDetail {
  const base = toDashboardProduct(input.product, input.previewSha256, input.reviewReason);
  return {
    ...base,
    brand: toDashboardBrand(input.product),
    name: input.translation?.name ?? base.name,
    defaultLocale: input.defaultLocale,
    summary: input.translation?.summary ?? "",
    readme: input.readme,
    versions: input.versions.map((version) => ({
      id: version.id,
      version: version.version,
      channel: version.channel,
      state: version.state,
      sforumVersion: version.sforumVersion,
      capabilities: version.capabilities,
      manifestDescription: version.manifestDescription,
      manifestUrl: version.manifestUrl,
      manifestAuthorName: version.manifestAuthorName,
      manifestAuthorUrl: version.manifestAuthorUrl,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      yankedAt: version.yankedAt?.toISOString() ?? null,
      yankReason: version.yankReason,
      createdAt: version.createdAt.toISOString(),
      assetPlatforms: version.platforms,
    })),
    publishedAt: input.product.publishedAt?.toISOString() ?? null,
    nameAtReview: input.product.nameAtReview,
    repoIdReviewed: input.product.repoIdReviewed,
    repoBoundAt: input.product.repoBoundAt?.toISOString() ?? null,
    repoBoundVia: input.product.repoBoundVia ?? null,
    capabilitiesReviewed: input.product.capabilitiesReviewed,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listDashboardProducts(
  db: Db,
  accountId: string,
): Promise<DashboardProduct[]> {
  const rows = await listProductsByOwner(db, accountId);
  const reasons = await listLatestRejectionReasons(
    db,
    rows.map((row) => row.product.id),
  );
  return rows.map((row) => ({
    ...toDashboardProduct(row.product, row.previewSha256, reasons.get(row.product.id) ?? null),
    name: row.translationName ?? row.product.name,
  }));
}

/** List row of the developer portal: the product plus what the "versions" column shows. */
export type DashboardProductRow = {
  product: DashboardProduct;
  latest: VersionSummary | null;
  versionCount: number;
};

/**
 * The dashboard list read model. `latest`/`versionCount` come from one owner-scoped
 * aggregate (`summary.ts`) rather than a detail read per product, so the statement count is
 * constant no matter how many products the account has.
 */
export async function listDashboardProductRows(
  db: Db,
  accountId: string,
): Promise<DashboardProductRow[]> {
  const [items, summaries] = await Promise.all([
    listDashboardProducts(db, accountId),
    listProductVersionSummaries(db, accountId),
  ]);
  return items.map((product) => {
    const summary = summaries.get(product.id) ?? EMPTY_VERSION_SUMMARY;
    return {
      product,
      latest: summary.latest,
      versionCount: summary.versionCount,
    };
  });
}

export async function requireOwnedProduct(
  db: DbExecutor,
  productId: string,
  accountId: string,
) {
  if (!isUuid(productId)) throw new ProductError("product_not_found", 404);
  const row = await findOwnedProduct(db, productId, accountId);
  // Other people's products are indistinguishable from missing ones.
  if (!row) throw new ProductError("product_not_found", 404);
  return row;
}

export async function getDashboardProduct(
  db: Db,
  input: { accountId: string; productId: string },
): Promise<DashboardProductDetail> {
  const { product, previewSha256 } = await requireOwnedProduct(
    db,
    input.productId,
    input.accountId,
  );
  const [translation, readme, repoFullName, versions, reasons] = await Promise.all([
    findTranslation(db, product.id, product.defaultLocale),
    getProductReadme(db, product.id),
    product.repoId === null ? null : findRepoFullName(db, product.repoId),
    listVersionRowsForProduct(db, product.id),
    listLatestRejectionReasons(db, [product.id]),
  ]);
  return toDetail({
    product,
    previewSha256,
    defaultLocale: product.defaultLocale,
    translation,
    // A cached README fetched from a repository the product is no longer bound to is not
    // this product's README: show nothing until the refresh replaces it.
    readme:
      readme !== null && product.repoId !== null && readme.repoId === product.repoId
        ? toDashboardReadme(readme, repoFullName)
        : null,
    versions,
    reviewReason: reasons.get(product.id) ?? null,
  });
}

// ---------------------------------------------------------------------------
// Create / patch / delist
// ---------------------------------------------------------------------------

export async function createProduct(
  db: Db,
  input: CreateProductInput,
): Promise<DashboardProductDetail> {
  const extensionId = input.extensionId.trim();
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new ProductError("invalid_extension_id", 400);
  }
  const name = normalizeName(input.name);
  const category = normalizeCategory(input.category);
  const tags = normalizeTags(input.tags ?? []);
  const locale = normalizeLocale(input.locale);
  const summary = sanitizeBounded(input.summary, MAX_SUMMARY_LENGTH) ?? "";
  const id = randomUUID();

  try {
    await db.transaction(async (tx) => {
      if (await findProductIdByExtensionId(tx, extensionId)) {
        throw new ProductError("extension_id_taken", 409);
      }
      const slug = await resolveSlug(tx, {
        name,
        id,
        slug: input.slug,
      });
      await insertProduct(tx, {
        id,
        extensionId,
        name,
        kind: input.kind,
        slug,
        ownerAccountId: input.accountId,
        category,
        tags,
        defaultLocale: locale,
      });
      await upsertTranslation(tx, {
        productId: id,
        locale,
        name,
        summary,
      });
    });
  } catch (error) {
    if (error instanceof ProductError) throw error;
    if (isUniqueViolation(error)) {
      // Lost a race: report the column that actually collided.
      if (await findProductIdByExtensionId(db, extensionId)) {
        throw new ProductError("extension_id_taken", 409);
      }
      throw new ProductError("slug_taken", 409);
    }
    throw error;
  }

  return getDashboardProduct(db, { accountId: input.accountId, productId: id });
}

export async function patchProduct(
  db: Db,
  input: { accountId: string; productId: string; patch: ProductPatch },
): Promise<DashboardProductDetail> {
  const { product } = await requireOwnedProduct(
    db,
    input.productId,
    input.accountId,
  );
  const { patch } = input;

  const fields: Parameters<typeof updateProductFields>[3] = {};
  if (patch.category !== undefined) {
    fields.category = normalizeCategory(patch.category);
  }
  if (patch.tags !== undefined) fields.tags = normalizeTags(patch.tags);
  await updateProductFields(db, product.id, input.accountId, fields);

  const existing = await findTranslation(db, product.id, product.defaultLocale);
  const summary =
    patch.summary !== undefined
      ? (sanitizeBounded(patch.summary, MAX_SUMMARY_LENGTH) ?? "")
      : (existing?.summary ?? "");

  await upsertTranslation(db, {
    productId: product.id,
    locale: product.defaultLocale,
    // The name is GitHub's; the translation row carries it forward unchanged.
    name: existing?.name ?? product.name,
    summary,
  });

  return getDashboardProduct(db, {
    accountId: input.accountId,
    productId: product.id,
  });
}

export async function delistProduct(
  db: Db,
  input: { accountId: string; productId: string },
): Promise<void> {
  const { product } = await requireOwnedProduct(
    db,
    input.productId,
    input.accountId,
  );
  // Soft delete: translations stay for moderation history.
  await delistProductRow(db, product.id, input.accountId);
}

// ---------------------------------------------------------------------------
// Public asset lookup (used by `GET /api/assets/{sha256}`)
// ---------------------------------------------------------------------------

export async function findImageAsset(
  db: Db,
  sha256: string,
): Promise<AssetRow | null> {
  return findAssetBySha256(db, sha256);
}

// ---------------------------------------------------------------------------
// Review lifecycle (developer side)
// ---------------------------------------------------------------------------

// `delisted` is here on purpose: §7.4 item 16 says a delisted product only comes back through
// a fresh submission + review, so the developer must be able to submit it again.
const SUBMITTABLE_STATUSES = new Set(["draft", "rejected", "pending_review", "delisted"]);
const REVIEWABLE_VERSION_STATES = new Set(["candidate", "pending_review"]);
const MAX_REASON_LENGTH = 500;

function normalizeReason(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ProductError("invalid_reason", 400);
  }
  const reason = raw.trim();
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
    throw new ProductError("invalid_reason", 400);
  }
  return reason;
}

/**
 * draft|rejected -> pending_review.
 *
 * A product with no reviewable version would land in a queue where the moderator can only
 * reject it, so submission requires one; and a blank summary would waste a review round.
 * Re-submitting an already-pending product is a no-op (idempotent 200, no second event).
 */
export async function submitProductForReview(
  db: Db,
  input: { accountId: string; productId: string; ip?: string | null },
): Promise<DashboardProductDetail> {
  const { product } = await requireOwnedProduct(db, input.productId, input.accountId);
  if (!SUBMITTABLE_STATUSES.has(product.status)) {
    throw new ProductError("invalid_state", 409);
  }
  if (product.status === "pending_review") {
    return getDashboardProduct(db, input);
  }

  const versions = await listVersionRowsForProduct(db, product.id);
  if (!versions.some((version) => REVIEWABLE_VERSION_STATES.has(version.state))) {
    throw new ProductError("no_reviewable_version", 409);
  }

  const translation = await findTranslation(db, product.id, product.defaultLocale);
  const name = (translation?.name ?? product.name).trim();
  const summary = (translation?.summary ?? "").trim();
  if (name.length === 0 || summary.length === 0) {
    throw new ProductError("missing_copy", 409);
  }

  const from = product.status;
  await db.transaction(async (tx) => {
    await updateProductReviewState(tx, product.id, { status: "pending_review" });
    await recordModerationEvent(tx, {
      productId: product.id,
      action: "submitted",
      fromState: from,
      toState: "pending_review",
      actorAccountId: input.accountId,
    });
    await recordAudit(tx, {
      actorAccountId: input.accountId,
      action: "product.submitted",
      targetType: "product",
      targetId: product.id,
      details: { from, versions: versions.length },
      ip: input.ip ?? null,
    });
  });

  return getDashboardProduct(db, input);
}

/**
 * published -> yanked for one version. Immediate effect: the public catalog drops it, a
 * signed link that is still valid answers 410 (plan §7.3 item 21), and the materialized
 * latest-version pointers are recomputed.
 */
export async function yankReleaseVersion(
  db: Db,
  input: {
    /** Owning forum account. Omitted when a store-local admin yanks someone else's version. */
    accountId?: string | null;
    actorAdminId?: string | null;
    versionId: string;
    reason: unknown;
    ip?: string | null;
  },
): Promise<DashboardProductDetail> {
  if (!isUuid(input.versionId)) {
    throw new ProductError("version_not_found", 404);
  }
  const reason = normalizeReason(input.reason);

  const found = await findVersionWithProduct(db, input.versionId);
  // Someone else's version is indistinguishable from a missing one — unless the caller is a
  // store-local admin, whose whole job here is acting on other people's products.
  if (!found) throw new ProductError("version_not_found", 404);
  if (!input.actorAdminId && found.product.ownerAccountId !== input.accountId) {
    throw new ProductError("version_not_found", 404);
  }
  if (found.version.state !== "published") {
    throw new ProductError("invalid_state", 409);
  }

  await db.transaction(async (tx) => {
    await updateReleaseVersionState(tx, found.version.id, {
      state: "yanked",
      yankedAt: new Date(),
      yankReason: reason,
    });
    await recordModerationEvent(tx, {
      releaseVersionId: found.version.id,
      action: "yanked",
      fromState: "published",
      toState: "yanked",
      actorAccountId: input.accountId ?? null,
      reason,
    });
    await recordAudit(tx, {
      actorAccountId: input.accountId ?? null,
      actorAdminId: input.actorAdminId ?? null,
      action: "release_version.yanked",
      targetType: "release_version",
      targetId: found.version.id,
      details: {
        version: found.version.version,
        reason,
        via: input.actorAdminId ? "admin" : "dashboard",
      },
      ip: input.ip ?? null,
    });
  });

  await recomputeProductLatestVersions(db, found.product.id);
  // The detail is always read as the owner, so an admin action returns the same shape a
  // developer would see.
  const ownerId = found.product.ownerAccountId ?? input.accountId;
  if (!ownerId) throw new ProductError("version_not_found", 404);
  return getDashboardProduct(db, {
    accountId: ownerId,
    productId: found.product.id,
  });
}
