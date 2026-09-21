/**
 * Pure parsing for CoinMarketCap's quotes/latest response — no imports, no
 * I/O, so it can be exercised on its own.
 *
 * Deliberately tolerant about response shape. CoinMarketCap's own docs say v1
 * endpoints return `data` as an object keyed by id/symbol while newer
 * versions "may return arrays instead", and "always confirm the response
 * shape in the endpoint reference" — but the per-endpoint v3 reference isn't
 * fetchable as plain text, so the exact shape couldn't be pinned down from
 * the docs alone. Rather than guess one, this accepts every plausible layout:
 *   - `data` as an array of coins, or an object keyed by id/symbol whose
 *     values are a coin or an array of coins
 *   - `quote` as an object keyed by currency ({ USD: {...} }), an array of
 *     per-currency objects ([{ symbol: "USD", price }] or [{ USD: {...} }]),
 *     or the price fields directly on the quote.
 * Anything it can't make sense of is skipped, never thrown on — a coin that
 * fails to parse just doesn't appear.
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

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Finds the USD figures inside whatever shape `quote` came back in. */
function pickUsdQuote(quote: unknown): Json | null {
  if (Array.isArray(quote)) {
    for (const entry of quote) {
      if (!isObject(entry)) continue;
      if (entry.symbol === "USD" || entry.convert === "USD") return entry;
      if (isObject(entry.USD)) return entry.USD;
    }
    return isObject(quote[0]) ? (quote[0] as Json) : null;
  }
  if (isObject(quote)) {
    if (isObject(quote.USD)) return quote.USD;
    if ("price" in quote) return quote;
  }
  return null;
}

/** Flattens `data` (array | object of coins | object of coin arrays) into a plain list of coin objects. */
function flattenCoins(data: unknown): Json[] {
  const items = Array.isArray(data) ? data : isObject(data) ? Object.values(data) : [];
  return items.flatMap((item) => (Array.isArray(item) ? item : [item])).filter(isObject);
}

/**
 * Maps a raw quotes/latest response onto the coins we track, in the order
 * given. Matches on CMC id first (the docs recommend ids — symbols aren't
 * unique and can change), falling back to symbol.
 */
export function parseQuotesLatest(json: unknown, tracked: readonly TrackedCoin[]): CoinPrice[] {
  const coins = isObject(json) ? flattenCoins(json.data) : [];
  const byId = new Map<number, Json>();
  const bySymbol = new Map<string, Json>();
  for (const coin of coins) {
    if (typeof coin.id === "number") byId.set(coin.id, coin);
    if (typeof coin.symbol === "string" && !bySymbol.has(coin.symbol)) bySymbol.set(coin.symbol, coin);
  }

  const out: CoinPrice[] = [];
  for (const t of tracked) {
    const coin = byId.get(t.id) ?? bySymbol.get(t.symbol);
    const usd = coin ? pickUsdQuote(coin.quote) : null;
    const price = usd ? num(usd.price) : null;
    if (!usd || price === null || price <= 0) continue;
    out.push({
      symbol: t.symbol,
      name: t.name,
      priceUsd: price,
      change1h: num(usd.percent_change_1h),
      change24h: num(usd.percent_change_24h),
      lastUpdated: typeof usd.last_updated === "string" ? usd.last_updated : null,
    });
  }
  return out;
}
