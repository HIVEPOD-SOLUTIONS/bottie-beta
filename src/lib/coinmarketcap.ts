import { getServerEnv } from "@/lib/server-env";
import { parseQuotesLatest, type PriceSnapshot, type TrackedCoin } from "@/lib/coinmarketcap-parse";

/**
 * Server-side CoinMarketCap client. Serves two things:
 *   1. the dashboard price ticker (getPrices, below), and
 *   2. the AI agent's market-data tools (cmcGetCached — see lib/ai/cmc-tools.ts).
 *
 * Why REST + a cache instead of CMC's WebSocket: the WebSocket is only on
 * paid plans (Startup and above), can't be opened from a browser (the API
 * key must go in a custom header), and bills per message — so it would need
 * a long-lived server relaying to every client, which this app's serverless
 * hosting can't hold open reliably. The REST endpoints work on every plan and
 * CMC only refreshes them about every 60s anyway, so polling faster returns
 * identical data and just burns credits.
 *
 * The API key never leaves the server; browsers only talk to /api/prices, and
 * the agent only ever sees the parsed results.
 */

const DEFAULT_CMC_BASE = "https://pro-api.coinmarketcap.com";

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

/** CMC answered, but with an error (bad symbol, plan doesn't include the endpoint, rate limit, out of credits…). */
export class CmcApiError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly errorCode: number | null) {
    super(message);
    this.name = "CmcApiError";
  }
}

function ttlMs(): number {
  // Floor of 15s: CMC updates ~every 60s, anything faster is pure waste.
  const seconds = Number(getServerEnv("COINMARKETCAP_CACHE_TTL_SECONDS"));
  return Math.max(15, Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
}

type Params = Record<string, string | number | undefined>;

/**
 * One uncached call to CMC. Returns the parsed body, or throws.
 *
 * Note CMC is inconsistent about errors: v3 returns error_code as a string
 * ("1001"), v1/v2 as an integer (1001), and an unknown path comes back as HTTP
 * 200 with error_code "500" — so success is judged on the status object, not
 * just the HTTP code.
 */
export async function cmcRequest(path: string, params: Params = {}): Promise<unknown> {
  const apiKey = getServerEnv("COINMARKETCAP_API_KEY");
  if (!apiKey) throw new PriceFeedNotConfiguredError();

  // COINMARKETCAP_API_BASE exists for tests / a proxy; production uses the default.
  const url = new URL(path, getServerEnv("COINMARKETCAP_API_BASE") ?? DEFAULT_CMC_BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));

  const res = await fetch(url, {
    // Header, not the CMC_PRO_API_KEY query param — CMC strongly recommends
    // it in production so the key can't end up in URLs or logs.
    headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });

  const body: unknown = await res.json().catch(() => null);
  const status = (body as { status?: { error_code?: number | string; error_message?: string } } | null)?.status;
  const errorCode = status?.error_code === undefined || status.error_code === "" ? 0 : Number(status.error_code);

  if (!res.ok || errorCode !== 0) {
    throw new CmcApiError(
      `CoinMarketCap ${res.status}${errorCode ? ` (${errorCode})` : ""}: ${status?.error_message ?? "request failed"}`,
      res.status,
      Number.isFinite(errorCode) && errorCode !== 0 ? errorCode : null,
    );
  }
  return body;
}

// ── Cache for the agent's calls ───────────────────────────────────────────────
// A chat can ask the same thing several times in a minute (and many users ask
// "price of BTC"); CMC only refreshes every ~60s, so identical calls within
// the TTL are served from memory at zero credit cost. Errors are never cached.
const MAX_CACHE_ENTRIES = 200;
const responseCache = new Map<string, { body: unknown; fetchedAt: number }>();
const inflightRequests = new Map<string, Promise<{ body: unknown; fetchedAt: number }>>();

export async function cmcGetCached(path: string, params: Params = {}): Promise<{ body: unknown; fetchedAt: number }> {
  const key = `${path}?${Object.entries(params).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&")}`;

  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < ttlMs()) return hit;

  // Concurrent identical requests share one upstream call.
  let pending = inflightRequests.get(key);
  if (!pending) {
    pending = cmcRequest(path, params)
      .then((body) => {
        const entry = { body, fetchedAt: Date.now() };
        responseCache.set(key, entry);
        if (responseCache.size > MAX_CACHE_ENTRIES) responseCache.delete(responseCache.keys().next().value as string);
        return entry;
      })
      .finally(() => { inflightRequests.delete(key); });
    inflightRequests.set(key, pending);
  }
  return pending;
}

/** A message safe to hand the user/agent for a failed CMC call — never leaks internals or the key. */
export function describeCmcError(err: unknown): string {
  if (err instanceof PriceFeedNotConfiguredError) return "Live market data isn't set up on this server yet.";
  if (err instanceof CmcApiError) {
    if (err.httpStatus === 403) return "That data isn't included in the current CoinMarketCap plan.";
    // 1008 per-minute limit, 1011 per-IP limit -> retry shortly.
    if (err.httpStatus === 429 || err.errorCode === 1008 || err.errorCode === 1011) {
      return "CoinMarketCap is rate-limiting requests right now — try again in a minute.";
    }
    // 1009 daily / 1010 monthly allowance, or 402 overdue -> retrying won't help soon.
    if (err.httpStatus === 402 || err.errorCode === 1009 || err.errorCode === 1010) return "The CoinMarketCap usage allowance has been reached for now.";
    if (err.httpStatus === 400) return `CoinMarketCap couldn't process that request (${err.message.replace(/^CoinMarketCap[^:]*:\s*/, "")}).`;
  }
  return "Market data is temporarily unavailable.";
}

// ── Dashboard ticker ──────────────────────────────────────────────────────────

// Module-level cache: one upstream call serves every user on this instance
// for the whole TTL, no matter how many clients poll. (On serverless each
// warm instance has its own copy, so worst case is one call per instance per
// TTL — still bounded, and the request never carries user-supplied ids.)
let cache: { snapshot: Omit<PriceSnapshot, "stale"> } | null = null;
let inflight: Promise<Omit<PriceSnapshot, "stale">> | null = null;

async function fetchTickerPrices(): Promise<Omit<PriceSnapshot, "stale">> {
  const body = await cmcRequest("/v3/cryptocurrency/quotes/latest", {
    id: TRACKED_COINS.map((c) => c.id).join(","),
    convert: "USD",
  });

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
  if (!getServerEnv("COINMARKETCAP_API_KEY")) throw new PriceFeedNotConfiguredError();

  if (cache && Date.now() - cache.snapshot.fetchedAt < ttlMs()) {
    return { ...cache.snapshot, stale: false };
  }

  // Concurrent requests during a refresh share one upstream call.
  inflight ??= fetchTickerPrices().finally(() => { inflight = null; });
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
