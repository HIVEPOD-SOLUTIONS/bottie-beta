import { pgTable, uuid, text, timestamp, numeric, uniqueIndex, boolean, index } from "drizzle-orm/pg-core";

export const goals = pgTable("goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  vaultId: text("vault_id").notNull(),
  name: text("name").notNull(),
  targetAmount: numeric("target_amount", { precision: 28, scale: 18 }).notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("goals_user_vault_idx").on(table.userId, table.vaultId),
]);

export const activities = pgTable("activities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  amount: text("amount").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  vaultId: text("vault_id"),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// bills table
export const bills = pgTable("bills", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(), // "streaming" | "cable" | "internet" | "utility" | "investment"
  amount: numeric("amount", { precision: 18, scale: 6 }).notNull(), // USDC amount
  dueDate: text("due_date"),
  payeeAddress: text("payee_address"),
  autopay: boolean("autopay").default(false).notNull(),
  status: text("status").default("pending").notNull(), // "pending" | "paid" | "overdue"
  logoUrl: text("logo_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// investments table
export const investments = pgTable("investments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(), // "stock" | "ipo" | "etf"
  shares: numeric("shares", { precision: 18, scale: 8 }).notNull(),
  avgPriceUsd: numeric("avg_price_usd", { precision: 18, scale: 6 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// velvet_vault_prefs — one row per (userId, portfolioAddress), status tracks visibility
export const velvetVaultPrefs = pgTable("velvet_vault_prefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  portfolioAddress: text("portfolio_address").notNull(), // lowercase 0x address
  status: text("status").notNull().default("added"),    // "added" | "hidden"
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("velvet_prefs_user_addr_idx").on(table.userId, table.portfolioAddress),
]);

/**
 * payments — unified ledger of every monetary event.
 *
 * type values:
 *   "bill"        — Bitrefill gift card / digital product purchase
 *   "investment"  — stock / ETF / pre-IPO share purchase
 *   "transfer"    — Circle Gateway or Solana USDC transfer to another wallet
 *   "deposit"     — Circle Gateway deposit (wallet → gateway balance)
 *   "withdrawal"  — Circle Gateway withdrawal (gateway balance → wallet)
 *   "bridge"      — Arc AppKit cross-chain USDC bridge
 *   "nanopay"     — Circle x402 nanopayment to an external resource
 *   "solpay"      — Solana MPP/x402 nanopayment to an external resource
 *   "x402"        — Unified x402 payment (auto-selects EVM or Solana)
 *   "onramp"      — INR → crypto via banking provider (Credible UPI onramp); starts pending, webhook marks completed
 *   "offramp"     — crypto → INR via banking provider (Credible offramp); starts pending, webhook marks completed
 */
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  referenceId: text("reference_id"),
  description: text("description").notNull(),
  amountUsdc: text("amount_usdc").notNull(),
  status: text("status").notNull(), // "pending" | "completed" | "failed"
  txHash: text("tx_hash"),
  chain: text("chain"), // "evm" | "solana"
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("payments_user_created_idx").on(table.userId, table.createdAt),
]);

/**
 * bitrefill_orders — full lifecycle of every Bitrefill invoice.
 *
 * Created when buy_bitrefill_product succeeds (status=pending).
 * Updated by poll_bitrefill_order (pending→complete/failed/expired).
 * Holds the redemption code once delivered.
 */
export const bitrefillOrders = pgTable("bitrefill_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  invoiceId: text("invoice_id").notNull(),           // Bitrefill invoice ID
  productId: text("product_id").notNull(),
  productName: text("product_name"),
  packageValue: text("package_value").notNull(),
  paymentMethod: text("payment_method").notNull(),   // e.g. "usdc_base", "bitcoin"
  isAddressBased: boolean("is_address_based").notNull().default(false),
  paymentAddress: text("payment_address"),           // deposit address (address-based methods)
  paymentAmount: text("payment_amount"),             // amount in payment currency
  paymentCurrency: text("payment_currency"),         // e.g. "USDC", "BTC"
  amountUsdc: text("amount_usdc"),                   // USD equivalent
  recipientEmail: text("recipient_email"),
  chain: text("chain"),                              // "evm" | "solana"
  status: text("status").notNull().default("pending"), // "pending" | "complete" | "failed" | "expired"
  redemptionCode: text("redemption_code"),
  esimInstallLink: text("esim_install_link"),
  // "Pay with XRP" — set only when paymentMethod === "xrp". Underlying
  // settlement is still a normal usdc_base/usdc_solana Bitrefill invoice;
  // these two columns link that invoice to the bluvfi-xrpl swap wallet that
  // collects XRP and swaps it into the invoice's own payment address.
  xrplWalletRequestId: text("xrpl_wallet_request_id"),
  xrplWalletAddress: text("xrpl_wallet_address"),
  // Set once the user has moved this order's stuck XRP (status failed/expired,
  // funds already reached xrplWalletRequestId but the swap never completed)
  // back to their sidebar wallet via /api/xrpl/transfer. Lets the
  // recoverable-orders list stop offering an order that's already been
  // recovered, without re-deriving that from bluvfi-xrpl's activity history
  // on every fetch.
  xrplRecoveredAt: timestamp("xrpl_recovered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("bitrefill_orders_invoice_idx").on(table.invoiceId),
  index("bitrefill_orders_user_idx").on(table.userId),
  index("bitrefill_orders_xrpl_wallet_request_idx").on(table.xrplWalletRequestId),
]);

/**
 * xrpl_sidebar_wallets — one persistent XRPL wallet per user, shown in the
 * sidebar. Created lazily (idempotent on the bluvfi-xrpl service side via
 * idempotencyKey="primary-xrp-wallet") the first time a user's sidebar
 * renders; this table just remembers the mapping so the app doesn't have to
 * re-create/re-fetch on every load. `walletRequestId` (not just `address`)
 * is required for the sidebar-to-purchase transfer flow — transferBetweenWallets
 * needs the source wallet's id, not its address.
 */
export const xrplSidebarWallets = pgTable("xrpl_sidebar_wallets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  walletRequestId: text("wallet_request_id").notNull(),
  address: text("address").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("xrpl_sidebar_wallets_user_idx").on(table.userId),
]);

/**
 * balance_snapshots — periodic wallet balance captures.
 *
 * Written after every successful balance refresh (every 30 s in the hook).
 * Deduplicated: only a new row is inserted when at least one balance changed
 * by more than $0.001 since the last snapshot.
 *
 * Enables balance history charts, net-worth tracking, and low-balance alerts.
 */
/**
 * weekly_insights — one Gemini-generated spending summary per user per week.
 *
 * weekStart is the ISO date (YYYY-MM-DD) of the Monday that began the week.
 * Only one row per (userId, weekStart) — upserted on re-generation.
 */
export const weeklyInsights = pgTable("weekly_insights", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  weekStart: text("week_start").notNull(),  // "YYYY-MM-DD" — Monday of the week
  summary: text("summary").notNull(),       // 3-sentence Gemini narrative
  totalSpentUsd: numeric("total_spent_usd", { precision: 18, scale: 2 }).default("0"),
  topCategory: text("top_category"),        // e.g. "bill", "bridge"
  balanceDeltaUsd: numeric("balance_delta_usd", { precision: 18, scale: 2 }).default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("weekly_insights_user_week_idx").on(table.userId, table.weekStart),
  index("weekly_insights_user_created_idx").on(table.userId, table.createdAt),
]);

export const balanceSnapshots = pgTable("balance_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  evmAddress: text("evm_address"),
  solAddress: text("sol_address"),
  evmUsdc: numeric("evm_usdc", { precision: 28, scale: 6 }).notNull().default("0"),
  evmUsdt: numeric("evm_usdt", { precision: 28, scale: 6 }).notNull().default("0"),
  solUsdc: numeric("sol_usdc", { precision: 28, scale: 6 }).notNull().default("0"),
  solUsdt: numeric("sol_usdt", { precision: 28, scale: 6 }).notNull().default("0"),
  totalUsdc: numeric("total_usdc", { precision: 28, scale: 6 }).notNull().default("0"), // sum of all four
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("balance_snapshots_user_created_idx").on(table.userId, table.createdAt),
]);
