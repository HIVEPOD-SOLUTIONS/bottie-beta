-- How a provider is set up beyond its listing: the inputs a caller fills in, what a person must do before using it, how Bluvfi
-- authenticates to the owner's API (the key is stored ENCRYPTED, see src/lib/secret-box.ts), and private notes for the Bluvfi team.
-- Applied by hand (Neon SQL editor). Safe to run twice: every statement is IF NOT EXISTS. Needs 0007_shar_rewards.sql first.
-- A separate table on purpose: listing reads never touch it, so a listing keeps working whether or not this has been run.
-- Run it BEFORE deploying the code that saves provider configuration.

CREATE TABLE IF NOT EXISTS "provider_configs" (
  "listing_id" uuid PRIMARY KEY,
  -- JSON text: the list of input fields callers fill in. NULL means free-form JSON.
  "input_fields" text,
  -- JSON text: up to five steps a person must do before using it. NULL means none.
  "requirements" text,
  "setup_url" text,
  -- Private: shown to the Bluvfi team only.
  "team_notes" text,
  -- "none" | "header" | "bearer"
  "auth_type" text DEFAULT 'none' NOT NULL,
  "auth_header" text,
  -- AES-256-GCM, "v1.<nonce>.<tag>.<ciphertext>". Never returned by any endpoint.
  "auth_secret_enc" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
