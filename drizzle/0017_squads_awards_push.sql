-- Three small features that share one migration, so there is one thing to run:
--   • Squads: friends pooling toward a weekly Shar goal (shar_squads, shar_squad_members).
--   • Weekly prizes: the Shar paid to last week's top places, one row per person per week (shar_weekly_awards). The primary key is what
--     makes paying a week twice impossible.
--   • Push tokens: the phone's notification address, so the server can tell someone their claim was paid or their provider was used.
-- Applied by hand (Neon SQL editor). Safe to run twice: every statement is IF NOT EXISTS. Needs 0007_shar_rewards.sql first.
-- Run it BEFORE deploying the code that uses it. Until it exists, squads answer "being set up", no prize is paid and push does nothing;
-- everything else in Shar is unaffected.

CREATE TABLE IF NOT EXISTS "shar_squads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the squad calls itself. Shown to its own members only; strangers see a generated name.
  "name" text NOT NULL,
  -- What friends type to join.
  "code" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "shar_squads_code_unique" UNIQUE ("code")
);
--> statement-breakpoint
-- One squad per person (the primary key), and the slot (1 to 10) is what caps a squad at ten: two people joining the last place at the
-- same moment can't both get it, because the second insert breaks the unique (squad_id, slot).
CREATE TABLE IF NOT EXISTS "shar_squad_members" (
  "user_id" text PRIMARY KEY,
  "squad_id" uuid NOT NULL REFERENCES "shar_squads" ("id") ON DELETE CASCADE,
  "slot" smallint NOT NULL,
  "joined_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "shar_squad_members_slot_range" CHECK ("slot" BETWEEN 1 AND 10),
  CONSTRAINT "shar_squad_members_slot_unique" UNIQUE ("squad_id", "slot")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shar_squad_members_squad_idx" ON "shar_squad_members" ("squad_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shar_weekly_awards" (
  -- The Monday (UTC) that began the week being paid.
  "week_start" date NOT NULL,
  "user_id" text NOT NULL,
  "place" integer NOT NULL,
  "shar" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "shar_weekly_awards_pk" PRIMARY KEY ("week_start", "user_id"),
  CONSTRAINT "shar_weekly_awards_positive" CHECK ("shar" > 0 AND "place" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shar_weekly_awards_user_idx" ON "shar_weekly_awards" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_tokens" (
  -- The phone's Firebase Cloud Messaging token. One phone can have it for one account at a time (signing in as someone else moves it).
  "token" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "platform" text NOT NULL DEFAULT 'android',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_tokens_user_idx" ON "push_tokens" ("user_id");
