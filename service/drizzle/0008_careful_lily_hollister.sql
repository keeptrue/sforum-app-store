CREATE TYPE "public"."repo_bound_via" AS ENUM('installation', 'github_identity');--> statement-breakpoint
CREATE TYPE "public"."repo_claim_state" AS ENUM('pending', 'claimed', 'rejected');--> statement-breakpoint
CREATE TABLE "repo_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"extension_id" text NOT NULL,
	"manifest_name" text,
	"tag" text,
	"github_release_id" bigint,
	"state" "repo_claim_state" DEFAULT 'pending' NOT NULL,
	"claimed_product_id" uuid,
	"claimed_by_account_id" uuid,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "repo_bound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "repo_bound_via" "repo_bound_via";--> statement-breakpoint
ALTER TABLE "repo_claims" ADD CONSTRAINT "repo_claims_claimed_product_id_products_id_fk" FOREIGN KEY ("claimed_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_claims" ADD CONSTRAINT "repo_claims_claimed_by_account_id_accounts_id_fk" FOREIGN KEY ("claimed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_claims_repo_extension_idx" ON "repo_claims" USING btree ("repo_id","extension_id");--> statement-breakpoint
CREATE INDEX "repo_claims_state_idx" ON "repo_claims" USING btree ("state","updated_at");