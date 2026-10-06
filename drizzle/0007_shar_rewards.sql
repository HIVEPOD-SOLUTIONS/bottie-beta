-- Shar rewards + the open provider network. Applied by hand like 0005/0006 (see drizzle/README or the Neon console).
-- Safe to run twice: everything is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "shar_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"referral_code" text NOT NULL,
	"referred_by" text,
	"referred_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shar_profiles_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
-- For databases that already ran an earlier version of this file: the column that records when a referral code was entered.
ALTER TABLE "shar_profiles" ADD COLUMN IF NOT EXISTS "referred_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shar_profiles_referred_by_idx" ON "shar_profiles" USING btree ("referred_by");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shar_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"shar" integer NOT NULL,
	"skr_amount" text NOT NULL,
	"wallet" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"tx_signature" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"paid_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shar_claims_user_created_idx" ON "shar_claims" USING btree ("user_id","created_at");
--> statement-breakpoint
-- One open request per user: this is what makes claiming safe without a transaction.
CREATE UNIQUE INDEX IF NOT EXISTS "shar_claims_one_open_idx" ON "shar_claims" USING btree ("user_id") WHERE status = 'requested';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text NOT NULL,
	"category" text NOT NULL,
	"endpoint_url" text NOT NULL,
	"docs_url" text,
	"price_usdc" text DEFAULT '0' NOT NULL,
	"payout_wallet" text NOT NULL,
	"remix_of_id" uuid,
	"status" text DEFAULT 'submitted' NOT NULL,
	"review_note" text,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_listings_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_listings_status_idx" ON "provider_listings" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_listings_owner_idx" ON "provider_listings" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"caller_user_id" text NOT NULL,
	"amount_usdc" text DEFAULT '0' NOT NULL,
	"shar" integer DEFAULT 0 NOT NULL,
	"settlement_ref" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_usage_listing_idx" ON "provider_usage" USING btree ("listing_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_usage_caller_idx" ON "provider_usage" USING btree ("caller_user_id","created_at");
