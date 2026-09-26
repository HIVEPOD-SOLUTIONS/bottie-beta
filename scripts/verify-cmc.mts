/**
 * Live CoinMarketCap verification — makes REAL calls to every endpoint Bluvfi uses and
 * prints the request and a slice of the response, so a reviewer can see it working.
 *
 *   npm run cmc:verify
 *
 * Needs COINMARKETCAP_API_KEY in .env (loaded via --env-file). The key is sent in the
 * X-CMC_PRO_API_KEY header and is never printed.
 */

const KEY = process.env.COINMARKETCAP_API_KEY;
if (!KEY) {
  console.error("COINMARKETCAP_API_KEY is not set — add it to .env first (https://coinmarketcap.com/api).");
  process.exit(1);
}
const BASE = "https://pro-api.coinmarketcap.com";

async function call(title: string, path: string, pick: (json: any) => unknown) {
  const res = await fetch(`${BASE}${path}`, { headers: { "X-CMC_PRO_API_KEY": KEY!, Accept: "application/json" } });
  const json: any = await res.json().catch(() => ({}));
  console.log(`\n── ${title}`);
  console.log(`   GET ${path}`);
  console.log(`   → HTTP ${res.status} · error_code ${JSON.stringify(json?.status?.error_code)} · credits ${json?.status?.credit_count ?? "?"}`);
  console.log("   " + JSON.stringify(pick(json), null, 1).replace(/\n/g, "\n   "));
  return json;
}

const usd = (c: any) => (Array.isArray(c.quote) ? c.quote.find((q: any) => q.symbol === "USD") : c.quote?.USD) ?? {};
const slim = (c: any) => ({ symbol: c.symbol, name: c.name, rank: c.cmc_rank, price: usd(c).price, "24h%": usd(c).percent_change_24h });

console.log(`Bluvfi × CoinMarketCap — live verification, ${new Date().toISOString()}`);

const q = await call("1. Live prices (dashboard ticker + get_crypto_prices)",
  "/v3/cryptocurrency/quotes/latest?id=1,1027,5426,52&convert=USD",
  (j) => (Array.isArray(j) ? j : j.data)?.map(slim));

await call("2. Top coins by market cap (get_crypto_market_overview, get_top_movers)",
  "/v3/cryptocurrency/listings/latest?limit=3&convert=USD",
  (j) => (Array.isArray(j) ? j : j.data)?.map(slim));

await call("3. Global market metrics (get_crypto_market_overview)",
  "/v1/global-metrics/quotes/latest",
  (j) => ({ btc_dominance: j.data?.btc_dominance, eth_dominance: j.data?.eth_dominance, active_cryptocurrencies: j.data?.active_cryptocurrencies }));

await call("4. Trending (get_trending_crypto — Startup plan and above)",
  "/v1/cryptocurrency/trending/latest?limit=3&time_period=24h",
  (j) => j.data?.map(slim));

await call("5. Price conversion (convert_crypto)",
  "/v2/tools/price-conversion?amount=250&symbol=XRP&convert=USD,NGN",
  (j) => { const d = Array.isArray(j.data) ? j.data[0] : j.data; return { symbol: d?.symbol, amount: d?.amount, quote: d?.quote }; });

// The two behaviours that only show up against the real API (see README → API feedback).
const dup = await call("6. Ticker collision: one symbol, many coins (why get_crypto_prices dedupes by rank)",
  "/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD",
  (j) => { const d = Array.isArray(j) ? j : j.data; return { coins_returned_for_BTC: d?.length, real_one_is_rank: Math.min(...d.map((c: any) => c.cmc_rank ?? Infinity)), examples: d?.slice(0, 4).map(slim) }; });

const a = await fetch(`${BASE}/v3/cryptocurrency/listings/latest?limit=5&sort=percent_change_24h&sort_dir=desc&market_cap_min=50000000&convert=USD`, { headers: { "X-CMC_PRO_API_KEY": KEY! } });
const aj: any = await a.json();
console.log("\n── 7. Filter order: market_cap_min is applied AFTER sort+limit (why get_top_movers ranks locally)");
console.log("   GET /v3/cryptocurrency/listings/latest?limit=5&sort=percent_change_24h&sort_dir=desc&market_cap_min=50000000");
console.log(`   → HTTP ${a.status} · rows returned: ${(Array.isArray(aj) ? aj : aj.data)?.length}  (expected 5 if the filter ran first)`);

console.log(`\nDone. ${q ? "" : "(no data)"}`);
void dup;
