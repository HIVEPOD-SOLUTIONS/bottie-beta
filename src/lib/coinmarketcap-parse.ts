/**
 * Pure parsing for CoinMarketCap responses — no imports, no I/O, so it can be
 * exercised on its own.
 *
 * Deliberately tolerant about shape, because CMC's endpoints disagree with
 * each other (verified against their docs' example responses):
 *   - `data` is a list of coins (listings, quotes v3, trending), a single coin
 *     object (price-conversion), or — on older endpoints — a map keyed by
 *     id/symbol whose values are a coin or a list of coins. The v3 quotes
 *     example is even shown as a bare top-level array with no `data` wrapper.
 *   - `quote` is a list of per-currency objects on v3 ([{ symbol: "USD", price }])
 *     but an object keyed by currency ({ USD: { price } }) on v1/v2.
 * Everything here accepts all of those. Anything it can't make sense of is
 * skipped, never thrown on — a coin that fails to parse just doesn't appear.
 */

export interface TrackedCoin {
  id: number;
  symbol: string;
  name: string;
}

export interface CoinPrice {
  symbol: string;
  name: string;
  priceUsd: number;
  /** Percent change, e.g. 1.25 means +1.25%. null when CMC didn't supply it. */
  change1h: number | null;
  change24h: number | null;
  lastUpdated: string | null;
}

export interface PriceSnapshot {
  prices: CoinPrice[];
  /** Epoch ms of the upstream fetch these prices came from. */
  fetchedAt: number;
  /** True when the upstream call failed and this is the last good data, served instead of an error. */
  stale: boolean;
}

/** One coin's market data in a single quote currency. */
export interface CoinQuote {
  id: number | null;
  symbol: string;
  name: string;
  slug: string | null;
  rank: number | null;
  price: number;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  marketCap: number | null;
  volume24h: number | null;
  lastUpdated: string | null;
}

export interface GlobalMetrics {
  totalMarketCap: number | null;
  totalVolume24h: number | null;
  btcDominance: number | null;
  ethDominance: number | null;
  activeCryptocurrencies: number | null;
  lastUpdated: string | null;
}

export interface Conversion {
  symbol: string;
  name: string | null;
  amount: number;
  /** Total value of `amount` in each requested currency (not a per-unit price). */
  results: Record<string, number>;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** The payload: a bare top-level array, or whatever sits under `data`. */
function rootData(json: unknown): unknown {
  if (Array.isArray(json)) return json;
  return isObject(json) ? json.data : null;
}

/** Flattens `data` into a plain list of coin objects, whatever layout it came in. */
function flattenCoins(data: unknown): Json[] {
  if (Array.isArray(data)) return data.flatMap((i) => (Array.isArray(i) ? i : [i])).filter(isObject);
  if (isObject(data)) {
    // A single coin (e.g. price-conversion) rather than a map of coins.
    if ("quote" in data || ("symbol" in data && "id" in data)) return [data];
    return Object.values(data).flatMap((i) => (Array.isArray(i) ? i : [i])).filter(isObject);
  }
  return [];
}

/** Finds the figures for one currency inside whatever shape `quote` came back in. Never substitutes another currency. */
function pickQuote(quote: unknown, currency: string): Json | null {
  const cur = currency.toUpperCase();
  if (Array.isArray(quote)) {
    for (const entry of quote) {
      if (!isObject(entry)) continue;
      if (String(entry.symbol ?? entry.convert ?? "").toUpperCase() === cur) return entry;
      if (isObject(entry[cur])) return entry[cur] as Json;
    }
    // A lone unlabelled entry can only be the USD default.
    const only = quote[0];
    if (cur === "USD" && quote.length === 1 && isObject(only) && "price" in only && !("symbol" in only)) return only;
    return null;
  }
  if (isObject(quote)) {
    if (isObject(quote[cur])) return quote[cur] as Json;
    if ("price" in quote && cur === "USD") return quote;
  }
  return null;
}

/** Every coin in the response that has a usable price in `currency`. */
export function parseCoins(json: unknown, currency = "USD"): CoinQuote[] {
  const out: CoinQuote[] = [];
  for (const coin of flattenCoins(rootData(json))) {
    const q = pickQuote(coin.quote, currency);
    const price = q ? num(q.price) : null;
    const symbol = str(coin.symbol);
    if (!q || price === null || price <= 0 || !symbol) continue;
    out.push({
      id: num(coin.id),
      symbol,
      name: str(coin.name) ?? symbol,
      slug: str(coin.slug),
      rank: num(coin.cmc_rank),
      price,
      change1h: num(q.percent_change_1h),
      change24h: num(q.percent_change_24h),
      change7d: num(q.percent_change_7d),
      change30d: num(q.percent_change_30d),
      marketCap: num(q.market_cap),
      volume24h: num(q.volume_24h),
      lastUpdated: str(q.last_updated) ?? str(coin.last_updated),
    });
  }
  return out;
}

/**
 * Maps a quotes response onto the coins the dashboard ticker tracks, in the
 * order given. Matches on CMC id first (the docs recommend ids — symbols
 * aren't unique and can change), falling back to symbol.
 */
export function parseQuotesLatest(json: unknown, tracked: readonly TrackedCoin[]): CoinPrice[] {
  const coins = parseCoins(json, "USD");
  const byId = new Map<number, CoinQuote>();
  const bySymbol = new Map<string, CoinQuote>();
  for (const c of coins) {
    if (c.id !== null) byId.set(c.id, c);
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, c);
  }

  const out: CoinPrice[] = [];
  for (const t of tracked) {
    const c = byId.get(t.id) ?? bySymbol.get(t.symbol);
    if (!c) continue;
    out.push({
      symbol: t.symbol,
      name: t.name,
      priceUsd: c.price,
      change1h: c.change1h,
      change24h: c.change24h,
      lastUpdated: c.lastUpdated,
    });
  }
  return out;
}

/** /v1/global-metrics/quotes/latest. The totals may sit under quote.<CUR> or directly on `data` (docs show both). */
export function parseGlobalMetrics(json: unknown, currency = "USD"): GlobalMetrics | null {
  const data = rootData(json);
  if (!isObject(data)) return null;
  const q = pickQuote(data.quote, currency) ?? data;
  const metrics: GlobalMetrics = {
    totalMarketCap: num(q.total_market_cap) ?? num(data.total_market_cap),
    totalVolume24h: num(q.total_volume_24h) ?? num(data.total_volume_24h),
    btcDominance: num(data.btc_dominance),
    ethDominance: num(data.eth_dominance),
    activeCryptocurrencies: num(data.active_cryptocurrencies),
    lastUpdated: str(q.last_updated) ?? str(data.last_updated),
  };
  return Object.values(metrics).every((v) => v === null) ? null : metrics;
}

/** /v2/tools/price-conversion. `price` per currency is the converted total for the whole `amount`. */
export function parseConversion(json: unknown, targets: readonly string[]): Conversion | null {
  const coin = flattenCoins(rootData(json))[0];
  if (!coin) return null;
  const amount = num(coin.amount);
  const symbol = str(coin.symbol);
  if (amount === null || !symbol) return null;

  const results: Record<string, number> = {};
  for (const t of targets) {
    const q = pickQuote(coin.quote, t);
    const price = q ? num(q.price) : null;
    if (price !== null) results[t.toUpperCase()] = price;
  }
  return Object.keys(results).length ? { symbol, name: str(coin.name), amount, results } : null;
}
