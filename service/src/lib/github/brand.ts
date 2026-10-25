import {
  GithubError,
  type GithubAppClient,
  type GithubRepoFile,
} from "./client";

/**
 * The brand files a repository may carry, read from the default branch with the
 * installation token.
 *
 * The layout is the host's own contract (`SForum/docs/extensions/brand-assets.md`): the
 * pictures live **inside the extension package**, next to `sforum.extension.json`:
 *
 *     sforum-oauth2-provider/                    <- package directory
 *       sforum.extension.json
 *       brand/icon.png
 *       brand/social-preview.png
 *
 * A standalone repository may have the package at its root, but a repository that ships
 * several extensions — or keeps its packages under `plugins/` — puts the manifest deeper:
 *
 *     plugins/sforum-oauth2-provider/sforum.extension.json
 *     plugins/sforum-oauth2-provider/brand/icon.png
 *
 * The release ZIP cannot tell us that path: by contract the manifest sits at the ZIP root,
 * so the archive is flattened and the repository layout is lost. The store therefore locates
 * the package directory in the repository: the root manifest first (cheap), then a recursive
 * tree listing filtered down to directories that contain a manifest, and the manifest `id`
 * decides which one belongs to the product.
 *
 * Only the file names below ever reach the Contents API — no product input, no manifest
 * field, no user-supplied path. `brand/icon.svg` is deliberately not read: the asset store
 * refuses SVG (it is a scriptable document, not a bitmap), and the host contract makes
 * `icon.png` mandatory whenever a package adopts the brand layout.
 */

export const MANIFEST_FILE = "sforum.extension.json";
export const BRAND_DIR = "brand";
export const BRAND_ICON_FILE = "icon.png";
export const BRAND_SOCIAL_FILE = "social-preview.png";

/** Repository-root paths, for the common "package is the repository" layout. */
export const BRAND_ICON_PATH = `${BRAND_DIR}/${BRAND_ICON_FILE}`;
export const BRAND_SOCIAL_PATH = `${BRAND_DIR}/${BRAND_SOCIAL_FILE}`;

/** The host caps the icon at 120 KiB and the card at 600 KiB; the store is looser on purpose. */
export const BRAND_ICON_MAX_BYTES = 1024 * 1024;
export const BRAND_SOCIAL_MAX_BYTES = 1024 * 1024;

/** A manifest is a few kilobytes; anything larger is not one we should parse. */
const MANIFEST_MAX_BYTES = 64 * 1024;

/** Bound on how many candidate package directories are opened to read their manifest. */
export const BRAND_PACKAGE_MAX_CANDIDATES = 5;

export type BrandFileFailureReason = "no_file" | "too_large" | "not_a_file" | "github_error";

export type BrandFileResult =
  | { ok: true; file: GithubRepoFile; path: string }
  | { ok: false; reason: BrandFileFailureReason; path: string; status: number | null };

/** The slice of the client this module needs, so tests can pass a fake. */
export type BrandFileReader = Pick<GithubAppClient, "getRepoFile">;

/** The same slice plus tree listing, for the layout lookup. */
export type BrandLayoutReader = BrandFileReader &
  Pick<GithubAppClient, "listRepoTree">;

/** `brand/<file>` for the repository root, `<dir>/brand/<file>` for a nested package. */
export function brandPath(dir: string, file: string): string {
  return dir === "" ? `${BRAND_DIR}/${file}` : `${dir}/${BRAND_DIR}/${file}`;
}

/**
 * Read one brand file. Every failure is a normal state: a repository that never adopted the
 * layout has no `brand/` directory at all, and that is not an error to surface as one.
 *
 * The GitHub status is carried back for `github_error` so the dashboard can say *which*
 * failure it was — "404 because there is no file" and "403 because the token lost access"
 * look identical otherwise, and that ambiguity already cost a debugging round.
 */
export async function fetchBrandFile(
  client: BrandFileReader,
  input: {
    fullName: string;
    installationId: number;
    ref?: string | null;
    dir: string;
    file: typeof BRAND_ICON_FILE | typeof BRAND_SOCIAL_FILE;
    maxBytes: number;
  },
): Promise<BrandFileResult> {
  const path = brandPath(input.dir, input.file);
  try {
    const file = await client.getRepoFile(
      input.fullName,
      input.installationId,
      path,
      { ref: input.ref ?? null, maxBytes: input.maxBytes },
    );
    return { ok: true, file, path };
  } catch (error) {
    if (error instanceof GithubError) {
      if (error.status === 404) return { ok: false, path, reason: "no_file", status: 404 };
      if (error.status === 413) return { ok: false, path, reason: "too_large", status: 413 };
      if (error.status === 415) return { ok: false, path, reason: "not_a_file", status: 415 };
      return { ok: false, path, reason: "github_error", status: error.status };
    }
    return { ok: false, path, reason: "github_error", status: null };
  }
}

export type BrandLayout = {
  /** Repository-relative package directory; `""` when the package is the repository root. */
  dir: string;
  /** Several package directories exist and none claims the product's extension id. */
  ambiguous: boolean;
};

/**
 * Where the extension package lives in the repository.
 *
 * Order: the root manifest (one small read, and the answer for a standalone package), then a
 * recursive tree filtered to directories holding a `sforum.extension.json`, whose manifests
 * are compared by `id`. A repository with exactly one package is accepted even when its id
 * does not match — the brand pictures are still that package's pictures, and the id mismatch
 * is a product-level problem the review flow already owns.
 *
 * Never throws: an unreadable tree, a truncated listing or an oversized repository all mean
 * "assume the package is at the root", which is the behaviour before layout lookup existed.
 */
export async function locateBrandDir(
  client: BrandLayoutReader,
  input: {
    fullName: string;
    installationId: number;
    ref?: string | null;
    extensionId: string;
  },
): Promise<BrandLayout> {
  const readId = (dir: string) =>
    readManifestId(client, {
      fullName: input.fullName,
      installationId: input.installationId,
      ref: input.ref ?? null,
      dir,
    });

  if ((await readId("")) === input.extensionId) {
    return { dir: "", ambiguous: false };
  }

  let tree;
  try {
    tree = await client.listRepoTree(input.fullName, input.installationId, {
      ref: input.ref ?? null,
    });
  } catch {
    return { dir: "", ambiguous: false };
  }
  if (tree.truncated) return { dir: "", ambiguous: false };

  const dirs = [
    ...new Set(
      tree.entries
        .filter((entry) => entry.type === "blob" && entry.path.endsWith(`/${MANIFEST_FILE}`))
        .map((entry) => entry.path.slice(0, -(MANIFEST_FILE.length + 1))),
    ),
  ]
    .filter((dir) => dir.length > 0)
    .slice(0, BRAND_PACKAGE_MAX_CANDIDATES);

  for (const dir of dirs) {
    if ((await readId(dir)) === input.extensionId) return { dir, ambiguous: false };
  }

  if (dirs.length === 1) return { dir: dirs[0]!, ambiguous: false };
  return { dir: "", ambiguous: dirs.length > 1 };
}

async function readManifestId(
  client: BrandFileReader,
  input: {
    fullName: string;
    installationId: number;
    ref: string | null;
    dir: string;
  },
): Promise<string | null> {
  const path = input.dir === "" ? MANIFEST_FILE : `${input.dir}/${MANIFEST_FILE}`;
  try {
    const file = await client.getRepoFile(
      input.fullName,
      input.installationId,
      path,
      { ref: input.ref, maxBytes: MANIFEST_MAX_BYTES },
    );
    const parsed = JSON.parse(file.bytes.toString("utf8")) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null;
  } catch {
    return null;
  }
}
