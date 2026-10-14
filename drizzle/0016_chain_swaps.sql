CREATE TABLE "chain_swaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"wallet_request_id" text NOT NULL,
	"purpose" text NOT NULL,
	"reference" text,
	"chain" text NOT NULL,
	"kind" text NOT NULL,
	"deposit_address" text,
	"deposit_memo" text,
	"refund_address" text NOT NULL,
	"pay_amount" text NOT NULL,
	"pay_symbol" text NOT NULL,
	"recipient" text NOT NULL,
	"receive_amount" text NOT NULL,
	"receive_asset" text NOT NULL,
	"amount_usd" text,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"swap_status" text,
	"user_tx_hash" text,
	"reported_at" timestamp,
	"swap_tx_hash" text,
	"error" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chain_swaps_wallet_request_idx" ON "chain_swaps" USING btree ("wallet_request_id");
--> statement-breakpoint
CREATE INDEX "chain_swaps_user_created_idx" ON "chain_swaps" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "chain_swaps_status_idx" ON "chain_swaps" USING btree ("status");
