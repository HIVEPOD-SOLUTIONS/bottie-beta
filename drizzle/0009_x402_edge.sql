-- x402 edge for outside agents: one receipt per payment, and one claim per on-chain signature. Applied by hand (Neon SQL editor).
-- Safe to run twice: every statement is IF NOT EXISTS. Needs 0007 and 0008 to have been run first.

-- ── One row per x402 payment an agent presents ───────────────────────────────
-- payload_hash is unique, so the same signed payment can never be used twice.
-- verifying -> calling -> settling -> settled, or failed at any step before the money moves.
-- A row left in "settling" means we asked the facilitator to move the money and never learned the answer: an admin checks it on-chain.
CREATE TABLE IF NOT EXISTS "x402_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"payer" text,
	"amount_micro" bigint NOT NULL,
	"status" text DEFAULT 'verifying' NOT NULL,
	"signature" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "x402_receipts_status_check" CHECK (status IN ('verifying', 'calling', 'settling', 'settled', 'failed')),
	CONSTRAINT "x402_receipts_amount_check" CHECK (amount_micro > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "x402_receipts_payload_idx" ON "x402_receipts" USING btree ("payload_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "x402_receipts_signature_idx" ON "x402_receipts" USING btree ("signature") WHERE signature IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "x402_receipts_status_idx" ON "x402_receipts" USING btree ("status", "updated_at");
--> statement-breakpoint

-- ── One claim per on-chain signature, across every way Bluvfi can be paid ─────
-- A top-up and an x402 payment both arrive at Bluvfi's wallet. Whichever one claims a signature first owns it, so a person
-- can't submit an agent payment's public signature as a credits top-up and be paid twice.
CREATE TABLE IF NOT EXISTS "signature_claims" (
	"signature" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "signature_claims_kind_check" CHECK (kind IN ('topup', 'x402'))
);
