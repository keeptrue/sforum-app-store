ALTER TABLE "products" ADD COLUMN "preview_source" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preview_blob_sha" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preview_note" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "preview_error" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "og_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "og_sha256" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "og_blob_sha" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "og_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "og_error" text;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_og_asset_id_assets_id_fk" FOREIGN KEY ("og_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;