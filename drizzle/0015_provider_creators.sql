-- Provider creators: becoming one is an OPT-IN sign-up, not something every account can do. A creator says who they are (a person, or a
-- company or team), gives a contact email (seen by the Bluvfi team only), and agrees to Bluvfi's provider terms. Until that is done,
-- adding a provider is refused. Applied by hand (Neon SQL editor). Safe to run twice: every statement is IF NOT EXISTS.
-- Needs 0007_shar_rewards.sql first. A separate table on purpose: listing reads never touch it. Run it BEFORE deploying the code that
-- checks it (until it exists, adding a provider answers "being set up"; browsing and using providers are unaffected).

CREATE TABLE IF NOT EXISTS "provider_creators" (
  "user_id" text PRIMARY KEY,
  -- "individual" (just the person) or "company" (a company or team)
  "operator_type" text NOT NULL,
  "company_name" text,
  "company_website" text,
  -- Seen by the Bluvfi team only. Never shown to other users.
  "contact_email" text NOT NULL,
  -- Which version of Bluvfi's provider terms they agreed to, and when (server clock). A newer version asks again before the next listing.
  "terms_version" text NOT NULL,
  "terms_accepted_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
