CREATE TYPE "public"."account_status" AS ENUM('active', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."issuer_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."store_role" AS ENUM('admin', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."token_set_status" AS ENUM('active', 'reauth_required');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer_key" text NOT NULL,
	"sub" text NOT NULL,
	"username" text,
	"display_name" text,
	"avatar_url" text,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_issuers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer_key" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ciphertext" text NOT NULL,
	"client_secret_kid" text NOT NULL,
	"scopes" text[] DEFAULT '{"profile","avatar"}' NOT NULL,
	"status" "issuer_status" DEFAULT 'active' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_token_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"issuer_key" text NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text,
	"token_type" text DEFAULT 'Bearer' NOT NULL,
	"scope" text,
	"expires_at" timestamp with time zone,
	"status" "token_set_status" DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_roles" (
	"account_id" uuid NOT NULL,
	"role" "store_role" NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_roles_account_id_role_pk" PRIMARY KEY("account_id","role")
);
--> statement-breakpoint
ALTER TABLE "oauth_token_sets" ADD CONSTRAINT "oauth_token_sets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_roles" ADD CONSTRAINT "store_roles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_issuer_sub_idx" ON "accounts" USING btree ("issuer_key","sub");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_issuers_key_idx" ON "oauth_issuers" USING btree ("issuer_key");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_token_sets_account_idx" ON "oauth_token_sets" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");