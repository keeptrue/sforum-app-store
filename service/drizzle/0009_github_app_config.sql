CREATE TABLE "github_app_config" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"app_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"api_base_url" text DEFAULT 'https://api.github.com' NOT NULL,
	"webhook_secret_ciphertext" text NOT NULL,
	"webhook_secret_keyring_kid" text NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_app_private_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" text NOT NULL,
	"app_key_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"keyring_kid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_app_private_keys" ADD CONSTRAINT "github_app_private_keys_config_id_github_app_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."github_app_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_config_singleton_idx" ON "github_app_config" USING btree ((true));--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_private_keys_app_key_id_idx" ON "github_app_private_keys" USING btree ("app_key_id");--> statement-breakpoint
CREATE INDEX "github_app_private_keys_config_idx" ON "github_app_private_keys" USING btree ("config_id");