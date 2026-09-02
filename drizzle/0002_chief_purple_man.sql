CREATE TABLE "xrpl_sidebar_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"wallet_request_id" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bitrefill_orders" ADD COLUMN "xrpl_wallet_request_id" text;--> statement-breakpoint
ALTER TABLE "bitrefill_orders" ADD COLUMN "xrpl_wallet_address" text;--> statement-breakpoint
CREATE UNIQUE INDEX "xrpl_sidebar_wallets_user_idx" ON "xrpl_sidebar_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bitrefill_orders_xrpl_wallet_request_idx" ON "bitrefill_orders" USING btree ("xrpl_wallet_request_id");