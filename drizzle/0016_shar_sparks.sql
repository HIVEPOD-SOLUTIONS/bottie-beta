-- Daily Spark: once a UTC day a person taps the Shar orb and collects a few Shar, with a streak. One row per person per day, and the
-- (user_id, day) primary key is what stops a second collect the same day, even from two taps at once. The Shar here counts like any other
-- (rank, weekly board, SKR claims); see src/lib/shar-spark-rules.ts for the amounts.
-- `seeker` records whether the person was a verified Seeker Genesis Token holder when they collected (checked on the server, never trusted from the app).
-- Applied by hand (Neon SQL editor). Safe to run twice: every statement is IF NOT EXISTS. Needs 0007_shar_rewards.sql first.
-- Run it BEFORE deploying the code that uses it: until it exists, Daily Spark answers "being set up" and everything else in Shar is unaffected.

CREATE TABLE IF NOT EXISTS "shar_sparks" (
  "user_id" text NOT NULL,
  "day" date NOT NULL,
  "shar" integer NOT NULL,
  "streak" integer NOT NULL,
  "seeker" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "shar_sparks_pk" PRIMARY KEY ("user_id", "day"),
  CONSTRAINT "shar_sparks_shar_positive" CHECK ("shar" > 0 AND "streak" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shar_sparks_day_idx" ON "shar_sparks" ("day");
