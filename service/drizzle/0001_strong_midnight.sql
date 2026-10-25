CREATE TYPE "public"."detection_source" AS ENUM('buildinfo', 'header', 'filename', 'manifest');--> statement-breakpoint
CREATE TYPE "public"."installation_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('plugin', 'theme');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'pending_review', 'published', 'rejected', 'delisted');--> statement-breakpoint
CREATE TYPE "public"."release_channel" AS ENUM('stable', 'beta');--> statement-breakpoint
CREATE TYPE "public"."release_state" AS ENUM('candidate', 'pending_review', 'published', 'rejected', 'yanked', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."repo_upstream_state" AS ENUM('connected', 'degraded', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('received', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_id" uuid,
	"account_login" text NOT NULL,
	"status" "installation_status" DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"default_branch" text,
	"upstream_state" "repo_upstream_state" DEFAULT 'connected' NOT NULL,
	"upstream_reason" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extension_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "product_kind" NOT NULL,
	"slug" text NOT NULL,
	"owner_account_id" uuid,
	"repo_id" bigint,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"default_locale" text DEFAULT 'zh-CN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_version_id" uuid NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"filename" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"upstream_asset_id" bigint NOT NULL,
	"detection_source" "detection_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"repo_release_id" uuid NOT NULL,
	"version" text NOT NULL,
	"channel" "release_channel" NOT NULL,
	"state" "release_state" DEFAULT 'candidate' NOT NULL,
	"sforum_version_constraint" text NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"notes_md" text,
	"yanked_at" timestamp with time zone,
	"yank_reason" text,
	"detection_issue" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"github_release_id" bigint NOT NULL,
	"tag" text NOT NULL,
	"target_commitish" text,
	"is_prerelease" boolean DEFAULT false NOT NULL,
	"body" text,
	"etag" text,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"status" "webhook_delivery_status" DEFAULT 'received' NOT NULL,
	"error" text,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_assets" ADD CONSTRAINT "release_assets_release_version_id_release_versions_id_fk" FOREIGN KEY ("release_version_id") REFERENCES "public"."release_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_versions" ADD CONSTRAINT "release_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_versions" ADD CONSTRAINT "release_versions_repo_release_id_repo_releases_id_fk" FOREIGN KEY ("repo_release_id") REFERENCES "public"."repo_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_id_idx" ON "github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repos_repo_id_idx" ON "github_repos" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "github_repos_installation_idx" ON "github_repos" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_extension_id_idx" ON "products" USING btree ("extension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_idx" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "release_assets_version_platform_idx" ON "release_assets" USING btree ("release_version_id","os","arch");--> statement-breakpoint
CREATE UNIQUE INDEX "release_versions_product_version_idx" ON "release_versions" USING btree ("product_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "release_versions_release_product_idx" ON "release_versions" USING btree ("repo_release_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_releases_repo_release_idx" ON "repo_releases" USING btree ("repo_id","github_release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_releases_repo_tag_idx" ON "repo_releases" USING btree ("repo_id","tag");