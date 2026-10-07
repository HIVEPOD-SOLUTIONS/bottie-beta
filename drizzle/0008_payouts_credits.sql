-- Admin audit, SKR payout states, caller credits, and owner commission. Applied by hand like 0007 (Neon SQL editor).
-- Safe to run twice: every statement is IF NOT EXISTS / IF EXISTS.
-- Needs 0007_shar_rewards.sql to have been run first.

-- ── Admin audit: who did what, to what, when ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_target_idx" ON "admin_audit" USING btree ("target_type","target_id","created_at");
--> statement-breakpoint

-- ── Shar claims: the payout state machine ────────────────────────────────────
-- requested -> processing -> sent -> paid, or back to requested if a send expired, or rejected.
ALTER TABLE "shar_claims" ADD COLUMN IF NOT EXISTS "last_valid_block_height" bigint;
--> statement-breakpoint
ALTER TABLE "shar_claims" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
-- A claim is "open" while it is in flight, not only while it is waiting: otherwise a second claim could be made against the same
-- Shar the moment the first one starts sending.
DROP INDEX IF EXISTS "shar_claims_one_open_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shar_claims_one_open_idx" ON "shar_claims" USING btree ("user_id") WHERE status IN ('requested', 'processing', 'sent');
--> statement-breakpoint

-- ── Paid provider calls ──────────────────────────────────────────────────────
-- The money columns are whole micro-USDC. owner_micro + platform_micro = paid_micro, always.
ALTER TABLE "provider_usage" ADD COLUMN IF NOT EXISTS "paid_micro" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN IF NOT EXISTS "owner_micro" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN IF NOT EXISTS "platform_micro" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- ── Caller credits ───────────────────────────────────────────────────────────
-- balance_micro can never go negative (the CHECK), so an overspend is impossible even if two calls race.
CREATE TABLE IF NOT EXISTS "credit_balances" (
	"user_id" text PRIMARY KEY NOT NULL,
	"balance_micro" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_balances_nonnegative" CHECK ("balance_micro" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL, -- 'topup' | 'call' | 'refund'
	"amount_micro" bigint NOT NULL, -- signed: negative for a call
	"ref" text, -- topup: the deposit signature; refund: the id of the call it undoes
	"listing_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_user_idx" ON "credit_ledger" USING btree ("user_id","created_at");
--> statement-breakpoint
-- One credit per deposit transaction, and one refund per call: replays do nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_once_idx" ON "credit_ledger" USING btree ("kind","ref") WHERE kind IN ('topup', 'refund');
--> statement-breakpoint

-- ── Owner commission ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "earnings_balances" (
	"user_id" text PRIMARY KEY NOT NULL,
	"available_micro" bigint DEFAULT 0 NOT NULL,
	"lifetime_micro" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "earnings_balances_nonnegative" CHECK ("available_micro" >= 0)
);
--> statement-breakpoint
-- A withdrawal of commission, paid out as SKR. The SKR amount is set when an admin clicks Pay (at that moment's price).
CREATE TABLE IF NOT EXISTS "commission_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"usd_micro" bigint NOT NULL,
	"skr_micro" bigint,
	"usd_per_skr" text,
	"wallet" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"tx_signature" text,
	"last_valid_block_height" bigint,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"paid_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_payouts_user_idx" ON "commission_payouts" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_payouts_one_open_idx" ON "commission_payouts" USING btree ("user_id") WHERE status IN ('requested', 'processing', 'sent');
