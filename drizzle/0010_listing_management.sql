-- Listing management: owners can edit, pause and remove their own listings; callers get an example request; the team can feature
-- verified providers. Applied by hand (Neon SQL editor). Safe to run twice: every statement is IF NOT EXISTS.
-- Needs 0007_shar_rewards.sql to have been run first. Run it BEFORE deploying the code that uses these columns.

-- A JSON example of a good request body, shown to callers and used as the starting point for "Try it". Stored as text (<= 1500 chars).
ALTER TABLE "provider_listings" ADD COLUMN IF NOT EXISTS "example_request" text;
--> statement-breakpoint
-- Promoted by the team. Only ever true while the listing is verified.
ALTER TABLE "provider_listings" ADD COLUMN IF NOT EXISTS "featured" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_listings" ADD COLUMN IF NOT EXISTS "featured_at" timestamp;
--> statement-breakpoint
-- Set when the OWNER paused it, so only the owner can resume it. A listing the team paused stays paused until the team resumes it.
ALTER TABLE "provider_listings" ADD COLUMN IF NOT EXISTS "paused_by_owner" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_listings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Removing a listing hides it everywhere but keeps its usage and earnings history (status becomes 'removed').
ALTER TABLE "provider_listings" ADD COLUMN IF NOT EXISTS "removed_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_listings_featured_idx" ON "provider_listings" USING btree ("featured", "verified_at") WHERE status = 'verified';
