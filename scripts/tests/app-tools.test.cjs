/**
 * Which agent tools the native Android app gets (src/lib/ai/app-tools.ts): an allowlist, so the money-moving operator, banking and
 * agent-wallet tools can never run from the app, and a tool added later is not exposed until someone decides it should be.
 *
 *     node scripts/tests/app-tools.test.cjs
 */
const fs = require("fs");
const path = require("path");
const { makeLoader, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

const load = makeLoader({});
const at = load("src/lib/ai/app-tools.ts");
const root = path.join(__dirname, "../..");
const dir = path.join(root, "src/lib/ai");

// every tool the chat can ever register, read from the source
const names = new Set();
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
  for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/^\s{2,6}([a-z0-9_]+): tool\(/gm)) names.add(m[1]);
}
const all = [...names].sort();
check("the tool inventory was read (a few hundred tools)", all.length > 300, `found ${all.length}`);

// ── every tool is a conscious decision
const unclassified = all.filter((n) => !at.isAppTool(n) && !at.isDeniedForApp(n));
check("every tool is either allowed or deliberately denied for the app (a new tool must be classified)", unclassified.length === 0, unclassified.join(", "));
check("no tool is both allowed and denied", all.every((n) => !(at.isAppTool(n) && at.isDeniedForApp(n))));
check("every exact name on the allowlist and denylist is a real tool (no typos, nothing stale)", [...at.APP_TOOL_NAMES, ...Object.keys(at.APP_DENIED_NAMES), ...at.APP_DENIED_WITHIN_PREFIXES].every((n) => names.has(n)), [...at.APP_TOOL_NAMES, ...Object.keys(at.APP_DENIED_NAMES), ...at.APP_DENIED_WITHIN_PREFIXES].filter((n) => !names.has(n)).join(", "));
check("every denied name carries a reason", Object.values(at.APP_DENIED_NAMES).every((r) => typeof r === "string" && r.length > 8));

// ── what must never reach the app
const mustNot = ["x402_pay", "solana_transfer_usdc", "initiate_payout", "send_payout", "transfer_to_payout_wallet", "transfer_sub_account_funds", "create_onramp_order", "create_offramp_order", "banking_transfer",
  "buy_investment", "get_market_prices", "create_goal", "doma_create_listing", "doma_prepare_buy", "grail_submit_buy", "grail_submit_sell", "grail_submit_redemption", "grail_cancel_redemption"];
const present = mustNot.filter((n) => names.has(n));
check("the dangerous tools exist today (so this test is guarding something real)", present.length >= 15, present.join(","));
check("none of the operator, banking, agent-wallet, signed-order or gold-trading tools is available to the app", present.every((n) => !at.isAppTool(n)));
check("no Fuze, SpherePay, Circle or Solana nanopayment tool is available to the app", all.filter((n) => /^(fuze_|spherepay_|nanopay_|solpay_)/.test(n)).every((n) => !at.isAppTool(n)));
check("xStocks and gold: only the public read-only lookups are allowed", all.filter((n) => /^(xstocks_|grail_)/.test(n) && at.isAppTool(n)).every((n) => /(list|get|price|corporate_actions|denominations|multiplier)/.test(n) && !/(submit|rfq|whitelist|sweeping|market_|create|cancel|find_user|list_users|get_user|quote)/.test(n)), all.filter((n) => /^(xstocks_|grail_)/.test(n) && at.isAppTool(n)).join(", "));

// ── what the app needs
const need = ["get_crypto_prices", "convert_crypto", "open_fund_wallet", "get_bills", "get_product_details", "buy_bitrefill_product", "poll_bitrefill_order", "get_bitrefill_orders", "buy_cryptorefills_product", "search_stocks", "trade_stock", "withdraw_stock_credit",
  "get_payment_history", "get_xrp_balance", "get_my_shar", "get_my_network_account", "search_network_providers", "get_provider_details", "get_my_activity", "getequity_get_member_balance", "doma_create_order", "doma_buy_listing", "nosana_list_deployments"];
check("everything the app has a screen or card for is still available", need.every((n) => at.isAppTool(n)), need.filter((n) => !at.isAppTool(n)).join(", "));
const network = [...fs.readFileSync(path.join(dir, "network-tools.ts"), "utf8").matchAll(/^\s{2,6}([a-z0-9_]+): tool\(/gm)].map((m) => m[1]);
check("all five Shar and network tools are allowed (they are app-only)", network.length === 5 && network.every((n) => at.isAppTool(n)));
check("the card-backed Backpack, Cryptorefills and Bitrefill tools are all allowed", all.filter((n) => /(_stock|stocks_|cryptorefills|bitrefill|_bills)/.test(n) && !/^xstocks_/.test(n)).every((n) => at.isAppTool(n)));

// ── the filter itself
const fake = Object.fromEntries(all.map((n) => [n, { name: n }]));
const kept = at.restrictForApp(fake);
check("restrictForApp keeps exactly the allowed tools and leaves the originals untouched", Object.keys(kept).every((n) => at.isAppTool(n)) && Object.keys(kept).length === all.filter((n) => at.isAppTool(n)).length && Object.keys(fake).length === all.length && kept.get_bills === fake.get_bills);
check("the app gets far fewer tools than the website", Object.keys(kept).length < all.length / 3, `${Object.keys(kept).length} of ${all.length}`);
check("a tool nobody has classified is left out of the app", !at.isAppTool("brand_new_payment_tool") && !("brand_new_payment_tool" in at.restrictForApp({ brand_new_payment_tool: {} })));

// ── it is actually wired in
const tools = fs.readFileSync(path.join(dir, "tools.ts"), "utf8");
check("createTools applies the allowlist for the native app only; the website still gets everything", /return client === "expo-android" \? restrictForApp\(all\) : all;/.test(tools) && tools.includes("function createAllTools("));
check("the app-only network tools are still added only for the native app", tools.includes('...(client === "expo-android" ? createNetworkTools(userId) : {})'));

finish();
