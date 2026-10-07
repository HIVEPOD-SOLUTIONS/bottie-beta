import { pgTable, uuid, text, timestamp, numeric, uniqueIndex, boolean, index, integer, bigint, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

/**
 * getequity_members — one row per (Bluvfi userId), mapping to the real GetEquity member
 * account created on their behalf. Created lazily on first GetEquity interaction that needs a
 * member id (see ensureGetEquityMember in src/lib/getequity-members.ts). This is a cache of
 * that mapping only — GetEquity is the ledger of record for the member's cash and holdings.
 */
export const getequityMembers = pgTable("getequity_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  memberId: text("member_id").notNull(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("getequity_members_user_idx").on(table.userId),
]);

/**
 * nosana_deployments — ownership record: which Bluvfi user created which Nosana deployment.
 *
 * Nosana itself has no per-user concept at all — the whole app shares one NOSANA_API_KEY /
 * prepaid-credit account, so every deployment lives in the same account with nothing in
 * Nosana's own API distinguishing whose is whose. Without this table, any logged-in Bluvfi user
 * could see, start, stop or archive any other user's deployment. This table is the only thing
 * enforcing that a user can only act on deployments they themselves created — see
 * src/lib/nosana-deployments.ts.
 */
export const nosanaDeployments = pgTable("nosana_deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  deploymentId: text("deployment_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("nosana_deployments_deployment_idx").on(table.deploymentId),
  index("nosana_deployments_user_idx").on(table.userId),
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

/**
 * Stocks (Backpack Exchange) — Bluvfi trades from ONE Backpack account for all
 * users, so these tables are the source of truth for who owns what.
 *
 * stock_balances: per-user holdings. asset "USDC" is stock cash; anything
 *   else is shares (e.g. "AAPL.US"). Changed only by single-statement SQL in
 *   lib/stocks-ledger.ts that also writes the ledger row, so the two can't
 *   drift and concurrent trades can't overspend (conditional UPDATE).
 * stock_ledger: append-only history. (kind, ref) is unique, so a deposit tx or
 *   fill can never be credited twice.
 * stock_orders: one row per RFQ/order sent to Backpack, with the cash reserved for it.
 */
export const stockBalances = pgTable("stock_balances", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  asset: text("asset").notNull(),
  amount: numeric("amount", { precision: 38, scale: 12 }).notNull().default("0"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("stock_balances_user_asset_idx").on(table.userId, table.asset),
]);

export const stockLedger = pgTable("stock_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),     // deposit | reserve | release | buy | sell | withdraw | withdraw_refund
  ref: text("ref").notNull(),       // tx hash, order id, withdrawal id…
  asset: text("asset").notNull(),
  amount: numeric("amount", { precision: 38, scale: 12 }).notNull(), // signed delta
  meta: text("meta"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("stock_ledger_kind_ref_asset_idx").on(table.kind, table.ref, table.asset),
  index("stock_ledger_user_created_idx").on(table.userId, table.createdAt),
]);

export const stockOrders = pgTable("stock_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  venue: text("venue").notNull(),               // "rfq" | "spot"
  externalId: text("external_id"),              // Backpack rfqId / orderId
  symbol: text("symbol").notNull(),             // AAPL.US_USDC_RFQ or MU.US_USDC
  asset: text("asset").notNull(),               // AAPL.US
  side: text("side").notNull(),                 // "buy" | "sell"
  quantity: numeric("quantity", { precision: 38, scale: 12 }).notNull(),
  limitPrice: numeric("limit_price", { precision: 38, scale: 12 }).notNull(),
  reservedUsdc: numeric("reserved_usdc", { precision: 38, scale: 12 }).notNull().default("0"),
  status: text("status").notNull().default("pending"), // pending | filled | cancelled | expired | failed
  fillQuantity: numeric("fill_quantity", { precision: 38, scale: 12 }),
  fillQuoteQuantity: numeric("fill_quote_quantity", { precision: 38, scale: 12 }),
  fillPrice: numeric("fill_price", { precision: 38, scale: 12 }),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("stock_orders_user_created_idx").on(table.userId, table.createdAt),
  index("stock_orders_status_idx").on(table.status),
]);

// Shared per-user rate-limit counters (see src/lib/rate-limit-store.ts). One row per bucket
// ("chat:daily:<userId>"); the row is reset in place when its window has passed.
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("rate_limits_reset_idx").on(table.resetAt),
]);

// ── Shar rewards (see src/lib/shar.ts) ───────────────────────────────────────
// Shar earned from spending is derived from `payments`, not stored, so it can never drift or double-count. These tables
// hold only what can't be derived: referral links, SKR claims, and the open provider network.

/** One row per user who has opened Shar: their referral code and who (if anyone) referred them. */
export const sharProfiles = pgTable("shar_profiles", {
  userId: text("user_id").primaryKey(),
  referralCode: text("referral_code").notNull().unique(),
  referredBy: text("referred_by"), // referrer's user id, set once
  /** When the code was entered. Only spending from this moment on earns the referrer a bonus. */
  referredAt: timestamp("referred_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("shar_profiles_referred_by_idx").on(table.referredBy),
]);

/** A request to take Shar out as SKR. Paid by the team; the user only ever has one open request at a time. */
export const sharClaims = pgTable("shar_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  shar: integer("shar").notNull(),
  skrAmount: text("skr_amount").notNull(), // decimal string, fixed when the claim is made
  wallet: text("wallet").notNull(),        // Solana address the SKR is sent to
  status: text("status").notNull().default("requested"), // "requested" | "processing" | "sent" | "paid" | "rejected"
  txSignature: text("tx_signature"),
  /** The last block the signed transaction can land in; once the chain is past it, a "sent" payout provably failed. */
  lastValidBlockHeight: bigint("last_valid_block_height", { mode: "number" }),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  paidAt: timestamp("paid_at"),
}, (table) => [
  index("shar_claims_user_created_idx").on(table.userId, table.createdAt),
  // Open = in flight (requested, processing or sent), so a second claim can't be made while one is being paid.
  uniqueIndex("shar_claims_one_open_idx").on(table.userId).where(sql`status IN ('requested', 'processing', 'sent')`),
]);

/** A provider or protocol someone added to the open network (or remixed from another listing). */
export const providerListings = pgTable("provider_listings", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: text("owner_user_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  summary: text("summary").notNull(),
  category: text("category").notNull(),      // "data" | "ai" | "payments" | "defi" | "identity" | "other"
  endpointUrl: text("endpoint_url").notNull(),
  docsUrl: text("docs_url"),
  priceUsdc: text("price_usdc").notNull().default("0"), // per call; paid calls settle over x402 (not enabled yet)
  payoutWallet: text("payout_wallet").notNull(),        // owner's Solana address for commission
  remixOfId: uuid("remix_of_id"),
  status: text("status").notNull().default("submitted"), // "submitted" | "verified" | "rejected" | "paused" | "removed"
  reviewNote: text("review_note"),
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  /** JSON text showing a good request body; the starting point for "Try it". */
  exampleRequest: text("example_request"),
  /** Promoted by the team; only ever true while verified. */
  featured: boolean("featured").notNull().default(false),
  featuredAt: timestamp("featured_at"),
  /** Paused by the owner (who can resume it), as opposed to by the team. */
  pausedByOwner: boolean("paused_by_owner").notNull().default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  removedAt: timestamp("removed_at"),
}, (table) => [
  index("provider_listings_status_idx").on(table.status),
  index("provider_listings_owner_idx").on(table.ownerUserId),
]);

/**
 * Who is behind a listing and the terms they accepted when they submitted it (see drizzle/0012). A separate table, so listing reads
 * never depend on it. contactEmail is for the Bluvfi team only.
 */
export const providerPublishers = pgTable("provider_publishers", {
  listingId: uuid("listing_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  operatorType: text("operator_type").notNull(), // "individual" | "company"
  companyName: text("company_name"),
  companyWebsite: text("company_website"),
  contactEmail: text("contact_email").notNull(),
  rightsConfirmed: boolean("rights_confirmed").notNull().default(false),
  termsVersion: text("terms_version").notNull(),
  termsAcceptedAt: timestamp("terms_accepted_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("provider_publishers_owner_idx").on(table.ownerUserId),
]);

/** Provider creators: an opt-in sign-up (see drizzle/0015). Not every account can list providers. */
export const providerCreators = pgTable("provider_creators", {
  userId: text("user_id").primaryKey(),
  operatorType: text("operator_type").notNull(), // "individual" | "company"
  companyName: text("company_name"),
  companyWebsite: text("company_website"),
  contactEmail: text("contact_email").notNull(), // the Bluvfi team only
  termsVersion: text("terms_version").notNull(),
  termsAcceptedAt: timestamp("terms_accepted_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * How a provider is set up beyond its listing (see drizzle/0013): input fields, requirements, setup link, private team notes, and
 * the encrypted credential Bluvfi uses to call the owner's API. A separate table, so listing reads never depend on it.
 */
export const providerConfigs = pgTable("provider_configs", {
  listingId: uuid("listing_id").primaryKey(),
  inputFields: text("input_fields"),     // JSON text, null = free-form
  requirements: text("requirements"),    // JSON text, null = none
  setupUrl: text("setup_url"),
  teamNotes: text("team_notes"),         // private
  authType: text("auth_type").notNull().default("none"), // "none" | "header" | "bearer"
  authHeader: text("auth_header"),
  authSecretEnc: text("auth_secret_enc"), // AES-256-GCM, never returned by any endpoint
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * An owner's own terms for the people who use their provider (see drizzle/0014), and who agreed to which version. Separate tables, so
 * listing reads never depend on them. These sit on top of Bluvfi's own terms, which always apply.
 */
export const providerTerms = pgTable("provider_terms", {
  listingId: uuid("listing_id").primaryKey(),
  termsText: text("terms_text"),
  termsUrl: text("terms_url"),
  termsHash: text("terms_hash").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const providerTermsAcceptances = pgTable("provider_terms_acceptances", {
  listingId: uuid("listing_id").notNull(),
  userId: text("user_id").notNull(),
  termsHash: text("terms_hash").notNull(),
  acceptedAt: timestamp("accepted_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.listingId, table.userId, table.termsHash] }),
  index("provider_terms_acceptances_user_idx").on(table.userId),
]);

/** One metered use of a verified provider; `shar` is what the owner earned for it. */
export const providerUsage = pgTable("provider_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id").notNull(),
  callerUserId: text("caller_user_id").notNull(),
  amountUsdc: text("amount_usdc").notNull().default("0"),
  shar: integer("shar").notNull().default(0),
  settlementRef: text("settlement_ref"), // x402 payment reference once paid calls are enabled
  /** Whole micro-USDC the caller paid, and how it was split. owner + platform = paid. */
  paidMicro: bigint("paid_micro", { mode: "number" }).notNull().default(0),
  ownerMicro: bigint("owner_micro", { mode: "number" }).notNull().default(0),
  platformMicro: bigint("platform_micro", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("provider_usage_listing_idx").on(table.listingId, table.createdAt),
  index("provider_usage_caller_idx").on(table.callerUserId, table.createdAt),
]);

// ── Admin audit, caller credits and owner commission (drizzle/0008_payouts_credits.sql) ──

/** Every action an admin takes on a listing, claim or payout, with who and when. */
export const adminAudit = pgTable("admin_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminUserId: text("admin_user_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  detail: text("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("admin_audit_target_idx").on(table.targetType, table.targetId, table.createdAt),
]);

/** What a caller has prepaid for paid provider calls, in whole micro-USDC. Never negative (a CHECK in the database). */
export const creditBalances = pgTable("credit_balances", {
  userId: text("user_id").primaryKey(),
  balanceMicro: bigint("balance_micro", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Append-only record of every credit movement: a top-up, a call, a refund. */
export const creditLedger = pgTable("credit_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(), // "topup" | "call" | "refund"
  amountMicro: bigint("amount_micro", { mode: "number" }).notNull(),
  ref: text("ref"),
  listingId: uuid("listing_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("credit_ledger_user_idx").on(table.userId, table.createdAt),
  uniqueIndex("credit_ledger_once_idx").on(table.kind, table.ref).where(sql`kind IN ('topup', 'refund')`),
]);

/** An owner's commission from paid calls, in whole micro-USDC. */
export const earningsBalances = pgTable("earnings_balances", {
  userId: text("user_id").primaryKey(),
  availableMicro: bigint("available_micro", { mode: "number" }).notNull().default(0),
  lifetimeMicro: bigint("lifetime_micro", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** A withdrawal of commission, paid as SKR. The SKR amount is fixed when an admin clicks Pay. */
export const commissionPayouts = pgTable("commission_payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  usdMicro: bigint("usd_micro", { mode: "number" }).notNull(),
  skrMicro: bigint("skr_micro", { mode: "number" }),
  usdPerSkr: text("usd_per_skr"),
  wallet: text("wallet").notNull(),
  status: text("status").notNull().default("requested"), // "requested" | "processing" | "sent" | "paid" | "rejected"
  txSignature: text("tx_signature"),
  lastValidBlockHeight: bigint("last_valid_block_height", { mode: "number" }),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  paidAt: timestamp("paid_at"),
}, (table) => [
  index("commission_payouts_user_idx").on(table.userId, table.createdAt),
  uniqueIndex("commission_payouts_one_open_idx").on(table.userId).where(sql`status IN ('requested', 'processing', 'sent')`),
]);

/** One payment an outside agent presented over x402. The unique payload hash means a signed payment can only be used once. */
export const x402Receipts = pgTable("x402_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  payer: text("payer"),
  amountMicro: bigint("amount_micro", { mode: "number" }).notNull(),
  status: text("status").notNull().default("verifying"), // verifying | calling | settling | settled | failed
  signature: text("signature"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("x402_receipts_payload_idx").on(table.payloadHash),
  uniqueIndex("x402_receipts_signature_idx").on(table.signature).where(sql`signature IS NOT NULL`),
  index("x402_receipts_status_idx").on(table.status, table.updatedAt),
]);

/** Who owns an on-chain signature: a credits top-up or an x402 payment, never both. */
export const signatureClaims = pgTable("signature_claims", {
  signature: text("signature").primaryKey(),
  kind: text("kind").notNull(), // topup | x402
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** The phones an account has used (a one-way hash of the Android ID), so accounts on the same phone can be linked. */
export const userDevices = pgTable("user_devices", {
  userId: text("user_id").notNull(),
  deviceHash: text("device_hash").notNull(),
  firstSeen: timestamp("first_seen").defaultNow().notNull(),
  lastSeen: timestamp("last_seen").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.deviceHash], name: "user_devices_pk" }),
  index("user_devices_hash_idx").on(table.deviceHash),
]);
