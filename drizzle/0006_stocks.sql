CREATE TABLE "stock_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(38, 12) DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(38, 12) NOT NULL,
	"meta" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"venue" text NOT NULL,
	"external_id" text,
	"symbol" text NOT NULL,
	"asset" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric(38, 12) NOT NULL,
	"limit_price" numeric(38, 12) NOT NULL,
	"reserved_usdc" numeric(38, 12) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"fill_quantity" numeric(38, 12),
	"fill_quote_quantity" numeric(38, 12),
	"fill_price" numeric(38, 12),
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_balances_user_asset_idx" ON "stock_balances" USING btree ("user_id","asset");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_ledger_kind_ref_asset_idx" ON "stock_ledger" USING btree ("kind","ref","asset");--> statement-breakpoint
CREATE INDEX "stock_ledger_user_created_idx" ON "stock_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_orders_user_created_idx" ON "stock_orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_orders_status_idx" ON "stock_orders" USING btree ("status");--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_non_negative" CHECK ("amount" >= 0);
