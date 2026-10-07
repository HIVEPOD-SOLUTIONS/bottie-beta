-- An owner's OWN terms for the people who use their provider (separate from Bluvfi's platform terms, which still apply), and a record
-- of who agreed to which version. Applied by hand (Neon SQL editor). Safe to run twice: every statement is IF NOT EXISTS.
-- Needs 0007_shar_rewards.sql first. Separate tables on purpose: listing reads never touch them, so a listing keeps working whether
-- or not this has been run. Run it BEFORE deploying the code that saves or checks them.

CREATE TABLE IF NOT EXISTS "provider_terms" (
  "listing_id" uuid PRIMARY KEY,
  -- The terms text shown to callers (<= 2000 chars) and/or a public https link to the full terms. At least one is set.
  "terms_text" text,
  "terms_url" text,
  -- A short fingerprint of the text + link. A person's agreement is to THIS version: change the terms and everyone is asked again.
  "terms_hash" text NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_terms_acceptances" (
  "listing_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "terms_hash" text NOT NULL,
  "accepted_at" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("listing_id", "user_id", "terms_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_terms_acceptances_user_idx" ON "provider_terms_acceptances" USING btree ("user_id");
