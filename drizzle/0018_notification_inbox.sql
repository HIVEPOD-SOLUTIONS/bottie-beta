-- Notifications without any push service: the server leaves short messages in an inbox, and the app asks for them now and then (in the
-- background, about every 15 minutes at best, and whenever it opens) and shows them as notifications. No Firebase, Expo or other account
-- is involved, so there is nothing to sign up for and no key to guard.
--   • notification_inbox: what to tell a person (a claim paid, a provider used). Only written for people who turned alerts on, and only ever
--     a title, a short line and a screen to open: no amounts, wallets or addresses.
--   • inbox_keys: the secret each phone reads its inbox with. Only a one-way hash is kept. It can read that person's notification text and
--     nothing else, and it is revoked when they turn alerts off.
-- Applied by hand (Neon SQL editor). Safe to run twice: every statement is IF NOT EXISTS. Run it BEFORE deploying the code that uses it:
-- until it exists, alerts answer "being set up" and everything else is unaffected.

CREATE TABLE IF NOT EXISTS "notification_inbox" (
  "id" bigserial PRIMARY KEY,
  "user_id" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  -- A bluvfi:// link the app opens when the notification is tapped.
  "url" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_inbox_user_idx" ON "notification_inbox" ("user_id", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbox_keys" (
  -- SHA-256 of the key the phone holds. The key itself is never stored.
  "key_hash" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "last_used_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_keys_user_idx" ON "inbox_keys" ("user_id");
