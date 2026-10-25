import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * One `langs` override from a manifest, minus the author email: the store displays the
 * localized name/description/homepage, and deliberately does not persist contact details.
 */
export type ManifestLocaleRow = {
  name?: string;
  description?: string;
  url?: string;
  author?: { name?: string; url?: string };
};

/**
 * Where a product mark came from. `brand_icon` is the repository file the host contract
 * defines (`brand/icon.png`); `social_preview` is the fallback GitHub renders for the repo
 * page. The fallback exists because most repositories never adopted the brand layout.
 */
export type BrandSource = "brand_icon" | "social_preview";

export const issuerStatus = pgEnum("issuer_status", ["active", "retired"]);
export const accountStatus = pgEnum("account_status", ["active", "orphaned"]);
export const storeRole = pgEnum("store_role", ["admin", "moderator"]);
export const tokenSetStatus = pgEnum("token_set_status", [
  "active",
  "reauth_required",
]);
// Admin identities are local to the store: they never come from a forum issuer
// (decisions/2026-10-25-admin-local-identity.md).
export const adminStatus = pgEnum("admin_status", ["active", "disabled"]);

export const oauthIssuers = pgTable(
  "oauth_issuers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    issuerKey: text("issuer_key").notNull(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
    clientSecretKid: text("client_secret_kid").notNull(),
    scopes: text("scopes").array().notNull().default(["profile", "avatar"]),
    status: issuerStatus("status").notNull().default("active"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_issuers_key_idx").on(table.issuerKey),
    // One login source per deployment: at most one `active` row. The expression index is
    // the only place a concurrent create can be stopped (the service-layer check races).
    uniqueIndex("oauth_issuers_single_active_idx")
      .on(sql`(true)`)
      .where(sql`status = 'active'`),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    issuerKey: text("issuer_key").notNull(),
    sub: text("sub").notNull(),
    username: text("username"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    status: accountStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounts_issuer_sub_idx").on(table.issuerKey, table.sub),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
    index("sessions_account_idx").on(table.accountId),
  ],
);

export const oauthTokenSets = pgTable(
  "oauth_token_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    issuerKey: text("issuer_key").notNull(),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    tokenType: text("token_type").notNull().default("Bearer"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: tokenSetStatus("status").notNull().default("active"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("oauth_token_sets_account_idx").on(table.accountId)],
);

export const storeRoles = pgTable(
  "store_roles",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: storeRole("role").notNull(),
    grantedBy: text("granted_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.role] })],
);


// Content-addressed uploads (images only; ZIPs never land here).
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("assets_sha256_idx").on(table.sha256)],
);

export const productKind = pgEnum("product_kind", ["plugin", "theme"]);
export const productStatus = pgEnum("product_status", [
  "draft",
  "pending_review",
  "published",
  "rejected",
  "delisted",
]);
export const releaseChannel = pgEnum("release_channel", ["stable", "beta"]);
export const releaseState = pgEnum("release_state", [
  "candidate",
  "pending_review",
  "published",
  "rejected",
  "yanked",
  "needs_attention",
]);
export const detectionSource = pgEnum("detection_source", [
  "buildinfo",
  "header",
  "filename",
  "manifest",
]);
export const repoUpstreamState = pgEnum("repo_upstream_state", [
  "connected",
  "degraded",
  "disconnected",
]);
export const installationStatus = pgEnum("installation_status", [
  "active",
  "suspended",
  "deleted",
]);
/**
 * How a product's repository binding was established. `installation` means "the account that
 * ran the GitHub App install flow"; `github_identity` means the binding was also checked
 * against a verified GitHub identity (decisions/2026-10-25-github-repo-binding.md).
 */
export const repoBoundVia = pgEnum("repo_bound_via", [
  "installation",
  "github_identity",
]);
export const repoClaimState = pgEnum("repo_claim_state", [
  "pending",
  "claimed",
  "rejected",
]);
export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "received",
  "processed",
  "failed",
]);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    extensionId: text("extension_id").notNull(),
    name: text("name").notNull(),
    kind: productKind("kind").notNull(),
    slug: text("slug").notNull(),
    ownerAccountId: uuid("owner_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    repoId: bigint("repo_id", { mode: "number" }),
    /** Set with `repoId`; cleared on unbind. Review compares `repoId`, not this. */
    repoBoundAt: timestamp("repo_bound_at", { withTimezone: true }),
    repoBoundVia: repoBoundVia("repo_bound_via"),
    status: productStatus("status").notNull().default("draft"),
    category: text("category"),
    tags: text("tags").array().notNull().default([]),
    /**
     * The product mark, downloaded once and stored as a content-addressed asset. There is no
     * upload path. Two sources, in order: the repository's `brand/icon.png` (the host
     * contract's own file) and GitHub's repository-page social preview. Null means the UI
     * draws the letter tile.
     */
    previewAssetId: uuid("preview_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    previewFetchedAt: timestamp("preview_fetched_at", { withTimezone: true }),
    /** Digest of the bytes in `previewAssetId`; lets a refetch skip a no-op write. */
    previewSha256: text("preview_sha256"),
    /** Which of the two sources produced `previewAssetId`. Null on pre-brand rows. */
    previewSource: text("preview_source").$type<BrandSource>(),
    /**
     * Git blob sha of `brand/icon.png`. A refresh compares it first, so an unchanged file
     * costs one contents call and no download.
     */
    previewBlobSha: text("preview_blob_sha"),
    /**
     * Why `brand/icon.png` was skipped while a mark still exists (e.g. `brand_not_square`).
     * Informational: the fallback already succeeded, the developer still needs the reason.
     */
    previewNote: text("preview_note"),
    /** Last failure that left the previous mark in place (icon is stale or absent). */
    previewError: text("preview_error"),
    /**
     * `brand/social-preview.png` (1280×640), served as the product page's Open Graph image.
     * Kept apart from the mark: a squarish icon is useless in a link preview and vice versa.
     */
    ogAssetId: uuid("og_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    ogSha256: text("og_sha256"),
    ogBlobSha: text("og_blob_sha"),
    ogFetchedAt: timestamp("og_fetched_at", { withTimezone: true }),
    ogError: text("og_error"),
    // Materialized semver maxima; no FK to avoid a cycle with release_versions.
    latestStableVersionId: uuid("latest_stable_version_id"),
    latestBetaVersionId: uuid("latest_beta_version_id"),
    // Review snapshot: what a moderator actually approved. A new release that adds a
    // capability not listed here, or a product renamed since approval, goes back to review.
    nameAtReview: text("name_at_review"),
    repoIdReviewed: bigint("repo_id_reviewed", { mode: "number" }),
    capabilitiesReviewed: text("capabilities_reviewed").array().notNull().default([]),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    defaultLocale: text("default_locale").notNull().default("zh-CN"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("products_extension_id_idx").on(table.extensionId),
    uniqueIndex("products_slug_idx").on(table.slug),
    index("products_status_updated_idx").on(
      table.status,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const productTranslations = pgTable(
  "product_translations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("product_translations_product_locale_idx").on(
      table.productId,
      table.locale,
    ),
  ],
);

/**
 * The rendered README of a product's bound repository.
 *
 * This is a cache, not an approval snapshot: the public page reads whatever GitHub serves
 * now (a recorded decision — the review only covers the summary and the manifest). The row
 * exists so a page view never waits on GitHub, and so the store can show *when* the text it
 * renders was fetched.
 *
 * `repo_id` is part of the cache key's meaning: after a rebind the row no longer describes
 * the product's repository and is refetched instead of displayed.
 */
export const productReadmes = pgTable(
  "product_readmes",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => products.id, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    /** `HEAD` today; stored so a future pinned read can be told apart from a live one. */
    ref: text("ref").notNull().default("HEAD"),
    /** Repository-relative path GitHub resolved, e.g. `README.md` or `docs/README.md`. */
    path: text("path").notNull(),
    /** GitHub blob digest; a changed value is what "the README changed" means. */
    blobSha: text("blob_sha").notNull(),
    /** Original source, kept so a renderer change can re-render without another fetch. */
    markdown: text("markdown").notNull(),
    /** `markdown` after the allow-list; the only representation the contract publishes. */
    html: text("html").notNull(),
    byteSize: integer("byte_size").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last failure while a previous good copy is still on screen; cleared on success. */
    fetchError: text("fetch_error"),
  },
  (table) => [index("product_readmes_repo_idx").on(table.repoId)],
);

/**
 * Every state transition that a human (or the sync worker) caused. `action` is free text on
 * purpose: the vocabulary grows with the review flow, and an unknown value must not fail a
 * migration. Product-level and version-level events share the table; exactly one of the two
 * subject columns is set.
 */
export const moderationEvents = pgTable(
  "moderation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    releaseVersionId: uuid("release_version_id").references(
      () => releaseVersions.id,
      { onDelete: "cascade" },
    ),
    action: text("action").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("moderation_events_product_idx").on(table.productId, table.createdAt),
    index("moderation_events_version_idx").on(
      table.releaseVersionId,
      table.createdAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Local admin identity (admin console)
// ---------------------------------------------------------------------------

/**
 * A store-local administrator. Deliberately NOT a row in `accounts`: that table's key is
 * `(issuer_key, sub)` and its meaning is "a forum identity". Mixing a password into it would
 * give "who is an admin" two sources. See the decision record.
 */
export const adminAccounts = pgTable(
  "admin_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    username: text("username").notNull(),
    /** `scrypt$N$r$p$salt_b64$hash_b64` — self-describing so parameters can be raised later. */
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    status: adminStatus("status").notNull().default("active"),
    /** Set when an admin creates the account with an initial password. */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("admin_accounts_username_idx").on(sql`lower(${table.username})`),
  ],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => adminAccounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("admin_sessions_token_hash_idx").on(table.tokenHash),
    index("admin_sessions_admin_idx").on(table.adminId),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    /** Set when the actor is a store-local administrator instead of a forum account. */
    actorAdminId: uuid("actor_admin_id").references(() => adminAccounts.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_created_idx").on(table.createdAt),
    index("audit_log_actor_idx").on(table.actorAccountId),
    index("audit_log_actor_admin_idx").on(table.actorAdminId),
    index("audit_log_target_idx").on(table.targetType, table.targetId),
  ],
);

/**
 * GitHub App credentials, written from the console instead of env (2026-10-25).
 *
 * A single row (`id = 'default'`, enforced by the expression unique index) so "the App" is
 * never ambiguous. Both secrets are ciphertext under `STORE_SECRET_KEYS`; the keyring stays in
 * env because it is the root that protects everything else, not configuration an operator
 * types into a form.
 */
export const githubAppConfig = pgTable(
  "github_app_config",
  {
    id: text("id").primaryKey().default("default"),
    appId: bigint("app_id", { mode: "number" }).notNull(),
    slug: text("slug").notNull(),
    apiBaseUrl: text("api_base_url")
      .notNull()
      .default("https://api.github.com"),
    webhookSecretCiphertext: text("webhook_secret_ciphertext").notNull(),
    webhookSecretKeyringKid: text("webhook_secret_keyring_kid").notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => [
    // One App per deployment, even against a hand-written insert.
    uniqueIndex("github_app_config_singleton_idx").on(sql`(true)`),
  ],
);

/**
 * Signing keys. Rotation is add-then-remove: GitHub keeps every uploaded key valid until it is
 * deleted, so the newest row signs (`lib/github/client.ts` takes the last key) and an older one
 * stays around until the operator removes it.
 *
 * `app_key_id` is the JWT header `kid`; `fingerprint` is the SHA-256 of the public key, shown in
 * the console so a key can be identified without ever displaying it.
 */
export const githubAppPrivateKeys = pgTable(
  "github_app_private_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => githubAppConfig.id, { onDelete: "cascade" }),
    appKeyId: text("app_key_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    ciphertext: text("ciphertext").notNull(),
    keyringKid: text("keyring_kid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("github_app_private_keys_app_key_id_idx").on(table.appKeyId),
    index("github_app_private_keys_config_idx").on(table.configId),
  ],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    accountLogin: text("account_login").notNull(),
    status: installationStatus("status").notNull().default("active"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("github_installations_installation_id_idx").on(
      table.installationId,
    ),
  ],
);

export const githubRepos = pgTable(
  "github_repos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    private: boolean("private").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    defaultBranch: text("default_branch"),
    upstreamState: repoUpstreamState("upstream_state")
      .notNull()
      .default("connected"),
    upstreamReason: text("upstream_reason"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("github_repos_repo_id_idx").on(table.repoId),
    index("github_repos_installation_idx").on(table.installationId),
  ],
);

/**
 * A repository published a release for an `extension_id` that no product owns yet.
 *
 * Sync records a claim instead of creating the product itself: product ownership used to be
 * whatever installation ran the sync, so the first release to arrive won the extension id.
 * A claim is a proposal; only a developer who can prove the repository is theirs turns it
 * into a product (`lib/github/claims.ts`).
 */
export const repoClaims = pgTable(
  "repo_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    extensionId: text("extension_id").notNull(),
    /** Manifest display name at claim time, so the queue can be read without GitHub. */
    manifestName: text("manifest_name"),
    tag: text("tag"),
    githubReleaseId: bigint("github_release_id", { mode: "number" }),
    state: repoClaimState("state").notNull().default("pending"),
    claimedProductId: uuid("claimed_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    claimedByAccountId: uuid("claimed_by_account_id").references(
      () => accounts.id,
      { onDelete: "set null" },
    ),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One open proposal per (repository, extension): a newer release refreshes the row
    // instead of stacking duplicates in the queue.
    uniqueIndex("repo_claims_repo_extension_idx").on(
      table.repoId,
      table.extensionId,
    ),
    index("repo_claims_state_idx").on(table.state, table.updatedAt),
  ],
);

export const repoReleases = pgTable(
  "repo_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    githubReleaseId: bigint("github_release_id", { mode: "number" }).notNull(),
    tag: text("tag").notNull(),
    targetCommitish: text("target_commitish"),
    isPrerelease: boolean("is_prerelease").notNull().default(false),
    body: text("body"),
    etag: text("etag"),
    syncState: text("sync_state").notNull().default("pending"),
    syncError: text("sync_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("repo_releases_repo_release_idx").on(
      table.repoId,
      table.githubReleaseId,
    ),
    uniqueIndex("repo_releases_repo_tag_idx").on(table.repoId, table.tag),
  ],
);

export const releaseVersions = pgTable(
  "release_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    repoReleaseId: uuid("repo_release_id")
      .notNull()
      .references(() => repoReleases.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    channel: releaseChannel("channel").notNull(),
    state: releaseState("state").notNull().default("candidate"),
    sforumVersionConstraint: text("sforum_version_constraint").notNull(),
    capabilities: text("capabilities").array().notNull().default([]),
    // Manifest display metadata. It is copied verbatim from the version's manifest so the
    // storefront and the moderation queue show what the host will show; the product's own
    // name still comes from the manifest and its introduction still comes from the README.
    manifestDescription: text("manifest_description"),
    manifestUrl: text("manifest_url"),
    manifestAuthorName: text("manifest_author_name"),
    manifestAuthorUrl: text("manifest_author_url"),
    manifestLangs: jsonb("manifest_langs")
      .$type<Record<string, ManifestLocaleRow>>()
      .notNull()
      .default({}),
    notesMd: text("notes_md"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    yankedAt: timestamp("yanked_at", { withTimezone: true }),
    yankReason: text("yank_reason"),
    detectionIssue: jsonb("detection_issue").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("release_versions_product_version_idx").on(
      table.productId,
      table.version,
    ),
    uniqueIndex("release_versions_release_product_idx").on(
      table.repoReleaseId,
      table.productId,
    ),
  ],
);

export const releaseAssets = pgTable(
  "release_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    releaseVersionId: uuid("release_version_id")
      .notNull()
      .references(() => releaseVersions.id, { onDelete: "cascade" }),
    os: text("os").notNull(),
    arch: text("arch").notNull(),
    filename: text("filename").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    upstreamAssetId: bigint("upstream_asset_id", { mode: "number" }).notNull(),
    detectionSource: detectionSource("detection_source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("release_assets_version_platform_idx").on(
      table.releaseVersionId,
      table.os,
      table.arch,
    ),
  ],
);

/**
 * Fixed-window counters shared by every replica. `bucket` is `<channel>:<subject>`
 * (e.g. `login:ip:203.0.113.7`); rows are keyed by window start so an expired window is
 * simply a different row, and old rows are swept opportunistically on write.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.bucket, table.windowStart] }),
    index("rate_limits_window_idx").on(table.windowStart),
  ],
);

/**
 * Runtime store settings (2026-10-25).
 *
 * Everything here used to be env-only, which meant a value an operator genuinely changes at
 * runtime — the address visitors use, how long a download link lives, how tight a rate limit
 * is — needed a redeploy and a restart of every process in lockstep. The row is the truth;
 * env stays as the seed used when a column is `null`, so an existing deployment keeps working
 * untouched and there is still exactly one answer per key.
 *
 * Secrets do not live here. `STORE_SESSION_SECRET`, `STORE_DOWNLOAD_SECRET` and the
 * `STORE_SECRET_KEYS` keyring are signing roots, not settings: rotating them is a different
 * feature with its own grace period, and putting them behind a form would make the console a
 * way to mint credentials.
 */
export const storeSettings = pgTable(
  "store_settings",
  {
    id: text("id").primaryKey().default("default"),
    /** `null` = fall back to `STORE_PUBLIC_URL`. Normalised, no trailing slash. */
    publicUrl: text("public_url"),
    /** `null` = the built-in 30 minutes. */
    downloadTtlSeconds: integer("download_ttl_seconds"),
    /**
     * `null` = follow `STORE_DOWNLOAD_MODE` (the seed). `proxy` / `redirect` pin it here.
     *
     * Text rather than a pg enum on purpose: a hand-edited bad value falls back to the seed
     * with a console warning, where an enum would make the whole row unreadable — and the row
     * is also the only way to fix the address.
     */
    downloadMode: text("download_mode"),
    /** channel → `"<limit>/<seconds>"`; a missing key falls back to env/defaults. */
    rateLimits: jsonb("rate_limits").$type<Record<string, string>>(),
    updatedByAdminId: uuid("updated_by_admin_id").references(
      () => adminAccounts.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => [
    // One settings row per deployment, even against a hand-written insert.
    uniqueIndex("store_settings_singleton_idx").on(sql`(true)`),
  ],
);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  action: text("action"),
  status: webhookDeliveryStatus("status").notNull().default("received"),
  error: text("error"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});
