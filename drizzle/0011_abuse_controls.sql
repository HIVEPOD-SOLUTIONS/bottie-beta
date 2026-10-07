-- Abuse controls beyond one account: which phones an account has used, so linked accounts can be spotted before a payout.
-- Applied by hand (Neon SQL editor). Safe to run twice. Needs 0007 first. The app works without it (the checks just report that
-- they aren't set up), but run it before you start paying claims.

-- One row per (account, phone). device_hash is a one-way hash of the phone's Android ID, never the ID itself.
CREATE TABLE IF NOT EXISTS "user_devices" (
	"user_id" text NOT NULL,
	"device_hash" text NOT NULL,
	"first_seen" timestamp DEFAULT now() NOT NULL,
	"last_seen" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_pk" PRIMARY KEY ("user_id", "device_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_devices_hash_idx" ON "user_devices" USING btree ("device_hash");
