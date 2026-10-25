ALTER TABLE "release_versions" ADD COLUMN "manifest_description" text;--> statement-breakpoint
ALTER TABLE "release_versions" ADD COLUMN "manifest_url" text;--> statement-breakpoint
ALTER TABLE "release_versions" ADD COLUMN "manifest_author_name" text;--> statement-breakpoint
ALTER TABLE "release_versions" ADD COLUMN "manifest_author_url" text;--> statement-breakpoint
ALTER TABLE "release_versions" ADD COLUMN "manifest_langs" jsonb DEFAULT '{}'::jsonb NOT NULL;