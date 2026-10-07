-- Who is behind a provider listing, and the terms they accepted when they submitted it. Applied by hand (Neon SQL editor).
-- Safe to run twice: every statement is IF NOT EXISTS. Needs 0007_shar_rewards.sql to have been run first.
-- It is a separate table on purpose: listing reads never touch it, so a listing keeps working whether or not this has been run.
-- Run it BEFORE deploying the code that submits listings (a submission is refused with "being set up" until it exists).

CREATE TABLE IF NOT EXISTS "provider_publishers" (
  "listing_id" uuid PRIMARY KEY,
  "owner_user_id" text NOT NULL,
  -- "individual" (just the person) or "company" (a company or team)
  "operator_type" text NOT NULL,
  "company_name" text,
  "company_website" text,
  -- Seen by the Bluvfi team only (to ask about a listing or a payout). Never shown to other users.
  "contact_email" text NOT NULL,
  -- They confirmed they own the service or are allowed to offer it.
  "rights_confirmed" boolean DEFAULT false NOT NULL,
  -- Which version of the provider terms they agreed to, and when (server clock).
  "terms_version" text NOT NULL,
  "terms_accepted_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_publishers_owner_idx" ON "provider_publishers" USING btree ("owner_user_id");
