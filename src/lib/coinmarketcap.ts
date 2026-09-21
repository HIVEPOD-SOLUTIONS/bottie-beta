import { getServerEnv } from "@/lib/server-env";
import { parseQuotesLatest, type PriceSnapshot, type TrackedCoin } from "@/lib/coinmarketcap-parse";

/**
 * Server-side CoinMarketCap client for the dashboard price ticker.
 *
 * Why REST + a cache instead of CMC's WebSocket: the WebSocket is only on
 * paid plans (Startup and above), can't be opened from a browser (the API
 * key must go in a custom header), and bills per message — so it would need
 * a long-lived server relaying to every client, which this app's serverless
 * hosting can't hold open reliably. The quotes REST endpoint works on every
 * plan and CMC only refreshes it about every 60s anyway, so polling it
 * faster returns identical data and just burns credits.
 *
 * The API key never leaves the server; browsers only talk to /api/prices.
 */

const CMC_BASE = "https://pro-api.coinmarketcap.com";

// CMC ids rather than symbols — CMC recommends ids because symbols aren't
// unique and can change on a rebrand.
export const TRACKED_COINS: readonly TrackedCoin[] = [
  { id: 1, symbol: "BTC", name: "Bitcoin" },
  { id: 1027, symbol: "ETH", name: "Ethereum" },
  { id: 5426, symbol: "SOL", name: "Solana" },
  { id: 52, symbol: "XRP", name: "XRP" },
];

export class PriceFeedNotConfiguredError extends Error {
  constructor() {
    super("COINMARKETCAP_API_KEY is not set");
    this.name = "PriceFeedNotConfiguredError";
  }
}

// Module-level cache: one upstream call serves every user on this instance
// for the whole TTL, no matter how many clients poll. (On serverless each
// warm instance has its own copy, so worst case is one call per instance per
// TTL — still bounded, and the request never carries user-supplied ids.)
let cache: { snapshot: Omit<PriceSnapshot, "stale"> } | null = null;
let inflight: Promise<Omit<PriceSnapshot, "stale">> | null = null;

function ttlMs(): number {
  // Floor of 15s: CMC updates ~every 60s, anything faster is pure waste.
  const seconds = Number(getServerEnv("COINMARKETCAP_CACHE_TTL_SECONDS"));
  return Math.max(15, Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
}

async function fetchFromCmc(apiKey: string): Promise<Omit<PriceSnapshot, "stale">> {
  const ids = TRACKED_COINS.map((c) => c.id).join(",");
  const res = await fetch(`${CMC_BASE}/v3/cryptocurrency/quotes/latest?id=${ids}&convert=USD`, {
    // Header, not the CMC_PRO_API_KEY query param — CMC strongly recommends
    // it in production so the key can't end up in URLs or logs.
    headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const status = (body as { status?: { error_code?: number; error_message?: string } } | null)?.status;
    throw new Error(`CoinMarketCap ${res.status}${status?.error_code ? ` (${status.error_code})` : ""}: ${status?.error_message ?? "request failed"}`);
  }

  const prices = parseQuotesLatest(body, TRACKED_COINS);
  if (prices.length === 0) {
    // A 200 that yields nothing means the response shape isn't what the
    // parser expects — log the structure (never the key) so it's diagnosable.
    const sample = JSON.stringify(body)?.slice(0, 400);
    throw new Error(`CoinMarketCap returned no parseable prices. Response began: ${sample}`);
  }
  return { prices, fetchedAt: Date.now() };
}

/**
 * Current prices, from cache when fresh. If CMC fails (rate limit, outage,
 * out of credits) the last good data is returned flagged `stale` instead of
 * an error, so the ticker keeps showing something rather than vanishing.
 * Throws only when there is no key, or a failure with nothing cached.
 */
export async function getPrices(): Promise<PriceSnapshot> {
  const apiKey = getServerEnv("COINMARKETCAP_API_KEY");
  if (!apiKey) throw new PriceFeedNotConfiguredError();

  if (cache && Date.now() - cache.snapshot.fetchedAt < ttlMs()) {
    return { ...cache.snapshot, stale: false };
  }

  // Concurrent requests during a refresh share one upstream call.
  inflight ??= fetchFromCmc(apiKey).finally(() => { inflight = null; });
  try {
    const snapshot = await inflight;
    cache = { snapshot };
    return { ...snapshot, stale: false };
  } catch (err) {
    if (cache) {
      console.warn("[prices] CoinMarketCap failed, serving stale prices:", err instanceof Error ? err.message : err);
      return { ...cache.snapshot, stale: true };
    }
    throw err;
  }
}
