-- 0011_github_only_products
--
-- Products now derive their identity from GitHub: the mark is a fetched social preview,
-- the description is the repository README, and screenshots are gone. This migration is
-- DESTRUCTIVE on purpose (decision 2026-10-25-github-only-product-identity):
--
--   * every uploaded icon reference, screenshot row and long-form description is removed;
--   * the `assets` rows and files themselves are kept (content-addressed, no way back);
--   * run `bun run backup:legacy-media` BEFORE this migration if the old media matters.
--
-- The README cache (`product_readmes`) is a cache, not an approval snapshot.

CREATE TABLE "product_readmes" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"ref" text DEFAULT 'HEAD' NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"markdown" text NOT NULL,
	"html" text NOT NULL,
	"byte_size" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetch_error" text
);
--> statement-breakpoint
ALTER TABLE "product_screenshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "product_screenshots" CASCADE;--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_icon_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preview_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preview_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preview_sha256" text;--> statement-breakpoint
ALTER TABLE "product_readmes" ADD CONSTRAINT "product_readmes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_readmes_repo_idx" ON "product_readmes" USING btree ("repo_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_preview_asset_id_assets_id_fk" FOREIGN KEY ("preview_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_translations" DROP COLUMN "description_md";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "icon_asset_id";