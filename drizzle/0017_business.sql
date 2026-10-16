CREATE TABLE "business_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"treasury_address" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"policy" text NOT NULL,
	"public_log" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "business_accounts_owner_idx" ON "business_accounts" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_accounts_treasury_idx" ON "business_accounts" USING btree ("treasury_address");
--> statement-breakpoint
CREATE TABLE "business_payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'vendor' NOT NULL,
	"address" text NOT NULL,
	"cap_usd" numeric(20, 6),
	"allowlisted" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "business_payees_business_idx" ON "business_payees" USING btree ("business_id");
--> statement-breakpoint
CREATE TABLE "business_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"payee_id" uuid NOT NULL,
	"amount_usdc" numeric(20, 6) NOT NULL,
	"due_at" timestamp NOT NULL,
	"memo" text,
	"invoice_ref" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"owner_approved" boolean DEFAULT false NOT NULL,
	"decision_note" text,
	"paid_tx" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "business_bills_business_status_idx" ON "business_bills" USING btree ("business_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_bills_invoice_idx" ON "business_bills" USING btree ("business_id","payee_id","invoice_ref");
--> statement-breakpoint
CREATE TABLE "business_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"bill_id" uuid,
	"actor" text NOT NULL,
	"summary" text NOT NULL,
	"inputs" text NOT NULL,
	"reasoning" text,
	"amount_usdc" numeric(20, 6),
	"tx_hash" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "business_decisions_seq_idx" ON "business_decisions" USING btree ("business_id","seq");
