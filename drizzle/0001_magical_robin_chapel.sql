CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"evm_address" text,
	"sol_address" text,
	"evm_usdc" numeric(28, 6) DEFAULT '0' NOT NULL,
	"evm_usdt" numeric(28, 6) DEFAULT '0' NOT NULL,
	"sol_usdc" numeric(28, 6) DEFAULT '0' NOT NULL,
	"sol_usdt" numeric(28, 6) DEFAULT '0' NOT NULL,
	"total_usdc" numeric(28, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bitrefill_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text,
	"package_value" text NOT NULL,
	"payment_method" text NOT NULL,
	"is_address_based" boolean DEFAULT false NOT NULL,
	"payment_address" text,
	"payment_amount" text,
	"payment_currency" text,
	"amount_usdc" text,
	"recipient_email" text,
	"chain" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"redemption_code" text,
	"esim_install_link" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "velvet_vault_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"portfolio_address" text NOT NULL,
	"status" text DEFAULT 'added' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"week_start" text NOT NULL,
	"summary" text NOT NULL,
	"total_spent_usd" numeric(18, 2) DEFAULT '0',
	"top_category" text,
	"balance_delta_usd" numeric(18, 2) DEFAULT '0',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "chain" text;--> statement-breakpoint
CREATE INDEX "balance_snapshots_user_created_idx" ON "balance_snapshots" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bitrefill_orders_invoice_idx" ON "bitrefill_orders" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "bitrefill_orders_user_idx" ON "bitrefill_orders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "velvet_prefs_user_addr_idx" ON "velvet_vault_prefs" USING btree ("user_id","portfolio_address");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_insights_user_week_idx" ON "weekly_insights" USING btree ("user_id","week_start");--> statement-breakpoint
CREATE INDEX "weekly_insights_user_created_idx" ON "weekly_insights" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_user_created_idx" ON "payments" USING btree ("user_id","created_at");