-- Add index on payments(user_id, created_at) for faster history queries
CREATE INDEX IF NOT EXISTS "payments_user_created_idx" ON "payments" ("user_id", "created_at");

-- bitrefill_orders: full invoice lifecycle (pending → complete/failed/expired + redemption code)
CREATE TABLE IF NOT EXISTS "bitrefill_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "invoice_id" text NOT NULL,
  "product_id" text NOT NULL,
  "product_name" text,
  "package_value" text NOT NULL,
  "payment_method" text NOT NULL,
  "is_address_based" boolean NOT NULL DEFAULT false,
  "payment_address" text,
  "payment_amount" text,
  "payment_currency" text,
  "amount_usdc" text,
  "recipient_email" text,
  "chain" text,
  "status" text NOT NULL DEFAULT 'pending',
  "redemption_code" text,
  "esim_install_link" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "bitrefill_orders_invoice_idx" ON "bitrefill_orders" ("invoice_id");
CREATE INDEX IF NOT EXISTS "bitrefill_orders_user_idx" ON "bitrefill_orders" ("user_id");

-- balance_snapshots: periodic wallet balance captures for history + net-worth tracking
CREATE TABLE IF NOT EXISTS "balance_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "evm_address" text,
  "sol_address" text,
  "evm_usdc" numeric(28, 6) NOT NULL DEFAULT '0',
  "evm_usdt" numeric(28, 6) NOT NULL DEFAULT '0',
  "sol_usdc" numeric(28, 6) NOT NULL DEFAULT '0',
  "sol_usdt" numeric(28, 6) NOT NULL DEFAULT '0',
  "total_usdc" numeric(28, 6) NOT NULL DEFAULT '0',
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "balance_snapshots_user_created_idx" ON "balance_snapshots" ("user_id", "created_at");
