CREATE TYPE "public"."install_auth_request_status" AS ENUM('pending', 'approved', 'denied', 'consumed', 'expired');--> statement-breakpoint
CREATE TABLE "account_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text DEFAULT 'download:issue' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"client_label" text,
	"created_ip" text,
	"user_agent" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "install_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_challenge" text NOT NULL,
	"client_label" text,
	"status" "install_auth_request_status" DEFAULT 'pending' NOT NULL,
	"account_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"interval_seconds" integer DEFAULT 2 NOT NULL,
	"created_ip" text,
	"user_agent" text,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store_settings" ADD COLUMN "download_auth_mode" text;--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_auth_requests" ADD CONSTRAINT "install_auth_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_tokens_token_hash_idx" ON "account_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_tokens_account_idx" ON "account_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "account_tokens_expiry_idx" ON "account_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "install_auth_requests_status_expiry_idx" ON "install_auth_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "install_auth_requests_created_idx" ON "install_auth_requests" USING btree ("created_at");