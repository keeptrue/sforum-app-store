/**
 * One TRUNCATE list for the integration suites.
 *
 * Every suite that resets the shared test database imports this instead of keeping its own
 * table list. Two reasons: a table missing from one list leaks rows into the next suite, and
 * adding a table to `schema.ts` used to mean editing a dozen hand-written strings.
 *
 * Order is irrelevant — `CASCADE` takes the foreign-key children along with their parents.
 * The suites that reset only a slice of the database on purpose (the audit trail, the rate
 * limiter counters) keep their own statements.
 */
export const TRUNCATE_TABLES = [
  "accounts",
  "admin_accounts",
  "admin_sessions",
  "assets",
  "audit_log",
  "github_app_config",
  "github_app_private_keys",
  "github_installations",
  "github_repos",
  "moderation_events",
  "oauth_issuers",
  "oauth_token_sets",
  "product_readmes",
  "product_translations",
  "products",
  "rate_limits",
  "release_assets",
  "release_versions",
  "repo_claims",
  "repo_releases",
  "sessions",
  "store_roles",
  "store_settings",
  "webhook_deliveries",
] as const;

export const TRUNCATE_ALL = `TRUNCATE TABLE ${TRUNCATE_TABLES.join(", ")} RESTART IDENTITY CASCADE`;
