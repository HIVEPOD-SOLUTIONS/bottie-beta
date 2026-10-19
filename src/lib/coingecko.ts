import type { CoinPrice, CoinQuote } from "@/lib/coinmarketcap-parse";

/**
 * CoinGecko fallback for the price screens. CoinMarketCap is the primary feed, but its key can
 * lapse (402 "subscription plan has expired") or hit limits; instead of an empty ticker we fall
 * back to CoinGecko's keyless public API. Server-side only, cached like the CMC calls.
 */

const BASE = "https://api.coingecko.com/api/v3";
const TTL_MS = 60_000;

/** CMC id → CoinGecko id for the dashboard ticker's fixed coin list. */
export const TICKER_GECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple",
  BNB: "binancecoin", TRX: "tron", HYPE: "hyperliquid", DOGE: "dogecoin", ADA: "cardano", LINK: "chainlink",
  NEAR: "near", XLM: "stellar", BCH: "bitcoin-cash", AVAX: "avalanche-2", LTC: "litecoin", SUI: "sui", DOT: "polkadot",
};

type GeckoMarket = {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  total_volume: number | null;
  last_updated: string | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
};

const cache = new Map<string, { at: number; rows: GeckoMarket[] }>();

async function markets(params: Record<string, string | number>): Promise<GeckoMarket[]> {
  const url = new URL(`${BASE}/coins/markets`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("price_change_percentage", "1h,24h,7d");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const key = url.toString();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const rows = (await res.json()) as GeckoMarket[];
  if (!Array.isArray(rows)) throw new Error("CoinGecko returned an unexpected response");
  cache.set(key, { at: Date.now(), rows });
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  return rows;
}

function toQuote(m: GeckoMarket): CoinQuote | null {
  if (typeof m.current_price !== "number") return null;
  return {
    id: null,
    symbol: m.symbol.toUpperCase(),
    name: m.name,
    slug: m.id,
    rank: m.market_cap_rank,
    price: m.current_price,
    change1h: m.price_change_percentage_1h_in_currency ?? null,
    change24h: m.price_change_percentage_24h_in_currency ?? null,
    change7d: m.price_change_percentage_7d_in_currency ?? null,
    change30d: null,
    marketCap: m.market_cap,
    volume24h: m.total_volume,
    lastUpdated: m.last_updated,
  };
}

/** The dashboard ticker's coins, in the given symbol order. */
export async function geckoTickerPrices(symbols: string[]): Promise<CoinPrice[]> {
  const ids = symbols.map((s) => TICKER_GECKO_IDS[s]).filter(Boolean);
  const rows = await markets({ ids: ids.join(","), per_page: ids.length });
  const out: CoinPrice[] = [];
  for (const s of symbols) {
    const q = rows.map(toQuote).find((r) => r && r.symbol === s);
    if (q) out.push({ symbol: q.symbol, name: q.name, priceUsd: q.price, change1h: q.change1h, change24h: q.change24h, lastUpdated: q.lastUpdated });
  }
  return out;
}

/** One page of coins by market cap (page is 1-based). */
export async function geckoListing(page: number, perPage: number): Promise<CoinQuote[]> {
  const rows = await markets({ order: "market_cap_desc", per_page: perPage, page });
  return rows.map(toQuote).filter((q): q is CoinQuote => q !== null);
}
