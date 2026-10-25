-- One login source per deployment (decisions/2026-10-24-app-store-identity-and-distribution.md).
-- A database that already holds several active issuers cannot be migrated silently: retiring
-- rows here would rewrite account provenance. Fail loudly with the fix instead.
DO $$
BEGIN
  IF (SELECT count(*) FROM "oauth_issuers" WHERE status = 'active') > 1 THEN
    RAISE EXCEPTION 'oauth_issuers 有多个 active 行：商城只允许一个登录来源。请先停用多余的 issuer（保留一个，其余 UPDATE oauth_issuers SET status = ''retired''）再重跑迁移。';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_issuers_single_active_idx" ON "oauth_issuers" USING btree ((true)) WHERE status = 'active';
