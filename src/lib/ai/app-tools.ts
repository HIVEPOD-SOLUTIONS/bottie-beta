/**
 * Which agent tools the native Android app gets.
 *
 * The website chat gets every tool. The app only has screens, cards and flows for some of them, and the rest either move money or
 * touch operator accounts with no screen to confirm it on (payouts, Fuze, SpherePay, the agent-wallet payments, signed Doma orders,
 * the sample "investments" catalog...). So for the app this is an ALLOWLIST: a tool is only registered if it is listed here, and a tool
 * added to the website later is NOT exposed to the app until someone decides it should be (a test fails until every tool is classified
 * as allowed or denied below).
 */

/** Exact names the app may use. */
export const APP_TOOL_NAMES: ReadonlySet<string> = new Set([
  // live market data
  "get_crypto_prices", "get_crypto_market_overview", "get_top_movers", "get_trending_crypto", "convert_crypto",
  // wallet UI
  "open_fund_wallet",
  // Bills: Bitrefill and Cryptorefills (the app has both payment cards)
  "get_bills", "get_product_details", "buy_bitrefill_product", "poll_bitrefill_order", "get_bitrefill_orders",
  "search_cryptorefills", "get_cryptorefills_products", "get_cryptorefills_payment_methods", "buy_cryptorefills_product",
  "get_cryptorefills_order", "get_cryptorefills_orders",
  // Invest: Backpack stocks and ETFs (confirm card, withdraw sheet)
  "search_stocks", "get_stock", "get_stock_portfolio", "trade_stock", "withdraw_stock_credit",
  // history
  "get_payment_history", "get_balance_history", "get_activities", "get_activity_narration",
  // the user's own XRP wallet
  "get_xrp_balance", "get_xrp_wallet", "get_xrp_activity", "get_xrp_payment_status", "list_recoverable_xrp", "recover_xrp_order", "fund_xrp_purchase_from_wallet",
  // Shar and the open provider network (app only)
  "get_my_shar", "get_my_network_account", "search_network_providers", "get_provider_details", "get_my_activity",
  // xStocks: public, read-only information. Buying them is not in the app.
  "xstocks_list_assets", "xstocks_get_asset", "xstocks_get_asset_price_data", "xstocks_corporate_actions_upcoming", "xstocks_corporate_actions_history",
  "xstocks_get_proof_of_reserves", "xstocks_list_proof_of_reserves", "xstocks_list_oracles", "xstocks_get_oracle", "xstocks_get_system_status",
  "xstocks_get_asset_multiplier", "xstocks_get_multiplier_history", "xstocks_list_public_bridges",
  // Oro gold: the price and the user's own trade and redemption history. Buying, selling and redeeming are not in the app.
  "grail_gold_price", "grail_get_denominations", "grail_list_trades", "grail_get_trade", "grail_list_redemptions", "grail_get_redemption",
]);

/** Whole families the app has a screen for: GetEquity (Invest), Doma (Invest) and Nosana (Invest). */
export const APP_TOOL_PREFIXES: readonly string[] = ["getequity_", "doma_", "nosana_"];

/** Inside an allowed family, tools that need a wallet-signed order the app can't produce, or that are raw developer data. */
export const APP_DENIED_WITHIN_PREFIXES: ReadonlySet<string> = new Set([
  "doma_create_listing", "doma_create_offer", "doma_cancel_listing", "doma_cancel_offer",
  "doma_create_bulk_listings", "doma_create_bulk_offers", "doma_prepare_buy", "doma_prepare_accept_offer",
]);

/** Families that are never available in the app (operator accounts, banking, agent wallets, B2B). */
export const APP_DENIED_PREFIXES: readonly string[] = [
  "fuze_", "spherepay_", "nanopay_", "solpay_", "xstocks_", "grail_",
  "get_banking_", "get_payout_", "get_onramp_", "get_offramp_", "get_nanopay_", "get_solpay_",
];

/** Single tools that are never available in the app, with the reason. */
export const APP_DENIED_NAMES: Readonly<Record<string, string>> = {
  add_offramp_bank_account: "banking is not in the app",
  banking_payout_trade: "banking is not in the app",
  banking_transfer: "banking is not in the app",
  create_banking_sub_account: "banking is not in the app",
  create_offramp_order: "banking is not in the app",
  create_onramp_order: "banking is not in the app",
  deactivate_offramp_bank_account: "banking is not in the app",
  initiate_banking_collection: "banking is not in the app",
  list_banking_payout_trades: "banking is not in the app",
  list_banking_sub_accounts: "banking is not in the app",
  list_offramp_orders: "banking is not in the app",
  list_onramp_orders: "banking is not in the app",
  review_offramp_bank_account: "banking is not in the app",
  validate_payout_bank_account: "payouts are an operator tool",
  initiate_payout: "payouts are an operator tool",
  send_payout: "payouts are an operator tool",
  list_payouts: "payouts are an operator tool",
  transfer_sub_account_funds: "payouts are an operator tool",
  transfer_to_payout_wallet: "payouts are an operator tool",
  get_sub_account_balance: "payouts are an operator tool",
  x402_pay: "pays from Bluvfi's own agent wallet, not the user's",
  solana_transfer_usdc: "pays from Bluvfi's own agent wallet, not the user's",
  buy_investment: "sample catalog with frozen illustrative prices",
  get_investments: "sample catalog with frozen illustrative prices",
  get_market_prices: "sample catalog with frozen illustrative prices",
  create_goal: "savings goals have no screen in the app",
  delete_goal: "savings goals have no screen in the app",
  get_goals: "savings goals have no screen in the app",
};

export function isAppTool(name: string): boolean {
  if (APP_TOOL_NAMES.has(name)) return true;
  if (APP_DENIED_WITHIN_PREFIXES.has(name)) return false;
  return APP_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

/** Whether a tool was deliberately kept out of the app (as opposed to simply never classified). */
export function isDeniedForApp(name: string): boolean {
  if (isAppTool(name)) return false; // a name allowed above wins over a denied family it sits in (e.g. the read-only xstocks_ lookups)
  return name in APP_DENIED_NAMES || APP_DENIED_WITHIN_PREFIXES.has(name) || APP_DENIED_PREFIXES.some((p) => name.startsWith(p));
}

/** Only the tools the app is allowed. Anything not listed is left out, including tools added after this was written. */
export function restrictForApp<T extends Record<string, unknown>>(tools: T): T {
  const kept: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) if (isAppTool(name)) kept[name] = t;
  return kept as T;
}
