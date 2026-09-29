import { createPrivateKey, sign as edSign } from "node:crypto";
import { getServerEnv } from "@/lib/server-env";

/**
 * Backpack Exchange client (server only) — US stocks & ETFs.
 *
 * Public: securities, market sessions/holidays, prices (source=External is the
 * fair-market price feed for stocks; the venue tape is thin).
 * Signed: RFQ trading, spot orders, deposit address, withdrawals, balances —
 * all on Bluvfi's single Backpack account (BACKPACK_API_KEY / BACKPACK_API_SECRET,
 * an ED25519 keypair created at backpack.exchange/settings/api-keys).
 *
 * Signing (docs.backpack.exchange → Authentication): body or query params
 * sorted by key as a query string, prefixed with `instruction=<name>&` and
 * suffixed with `&timestamp=<ms>&window=<ms>`, signed with ED25519, base64.
 */

export const BACKPACK_API = "https://api.backpack.exchange";
const WINDOW_MS = 10_000;

export class BackpackError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly code: string | null) {
    super(message);
    this.name = "BackpackError";
  }
}

export function backpackConfigured(): boolean {
  return !!(getServerEnv("BACKPACK_API_KEY") && getServerEnv("BACKPACK_API_SECRET"));
}

// ── Signing ──────────────────────────────────────────────────────────────────

type Params = Record<string, string | number | boolean | undefined>;

// PKCS#8 DER header for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function privateKey() {
  const seed = Buffer.from(getServerEnv("BACKPACK_API_SECRET") ?? "", "base64");
  if (seed.length !== 32) throw new BackpackError("BACKPACK_API_SECRET must be a base64 32-byte ED25519 seed", 500, "NOT_CONFIGURED");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

function toQuery(params: Params): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

function signedHeaders(instruction: string, params: Params): Record<string, string> {
  const apiKey = getServerEnv("BACKPACK_API_KEY");
  if (!apiKey) throw new BackpackError("Backpack isn't configured on this server", 501, "NOT_CONFIGURED");
  const timestamp = Date.now();
  const q = toQuery(params);
  const payload = `instruction=${instruction}${q ? `&${q}` : ""}&timestamp=${timestamp}&window=${WINDOW_MS}`;
  const signature = edSign(null, Buffer.from(payload), privateKey()).toString("base64");
  return {
    "X-API-Key": apiKey,
    "X-Signature": signature,
    "X-Timestamp": String(timestamp),
    "X-Window": String(WINDOW_MS),
  };
}

async function bpError(res: Response): Promise<BackpackError> {
  const text = await res.text().catch(() => "");
  let body: { code?: string; message?: string } | null = null;
  try { body = JSON.parse(text); } catch { /* plain text */ }
  return new BackpackError(body?.message ?? (text.slice(0, 200) || `Backpack ${res.status}`), res.status, body?.code ?? null);
}

async function bpPublic<T>(path: string, params: Params = {}): Promise<T> {
  const q = toQuery(params);
  const res = await fetch(`${BACKPACK_API}${path}${q ? `?${q}` : ""}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw await bpError(res);
  return (await res.json()) as T;
}

async function bpSigned<T>(method: "GET" | "POST" | "DELETE", path: string, instruction: string, params: Params = {}): Promise<T> {
  const headers = signedHeaders(instruction, params);
  const isGet = method === "GET";
  const q = toQuery(params);
  const res = await fetch(`${BACKPACK_API}${path}${isGet && q ? `?${q}` : ""}`, {
    method,
    headers: { ...headers, Accept: "application/json", ...(isGet ? {} : { "Content-Type": "application/json" }) },
    body: isGet ? undefined : JSON.stringify(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await bpError(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ── Cache for public reference data ──────────────────────────────────────────

const cache = new Map<string, { at: number; data: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ── Market data (public) ─────────────────────────────────────────────────────

export interface Security {
  asset: string;   // "AAPL.US"
  name: string;
  cusip?: string;
  sessions: { name: string; minQuantity: string; maxQuantity: string; stepSize: string }[];
}

export interface MarketSession {
  name: string;
  description?: string;
  startTime: string;     // "09:30:00" local
  endTime: string;
  startWeekday: number;  // ISO: 1 = Monday … 7 = Sunday
  endWeekday: number;
  timezone: string;
}

export interface MarketHoliday { market: string; name: string; date: string; startTime?: string; endTime?: string; timezone: string }

export interface Ticker {
  symbol: string;
  firstPrice: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  high: string;
  low: string;
  volume: string;
  quoteVolume: string;
}

export interface Kline { start: string; end?: string; open: string; high: string; low: string; close: string; volume?: string }

export const listSecurities = () => cached("securities", 60 * 60_000, () => bpPublic<Security[]>("/api/v1/securities"));
export const listMarketSessions = () => cached("sessions", 60 * 60_000, () => bpPublic<MarketSession[]>("/api/v1/market-sessions"));
export const listMarketHolidays = () => cached("holidays", 60 * 60_000, () => bpPublic<MarketHoliday[]>("/api/v1/market-holidays"));

/** Spot order-book stock markets (e.g. MU.US_USDC) — tradable outside RFQ hours. */
export const listStockSpotMarkets = () =>
  cached("spot-markets", 30 * 60_000, async () => {
    const markets = await bpPublic<{ symbol: string; rwaMarketType?: string; marketType?: string; orderBookState?: string }[]>("/api/v1/markets");
    return markets
      .filter((m) => m.rwaMarketType === "STOCK" && !m.symbol.endsWith("_PERP") && (m.marketType ?? "SPOT") === "SPOT")
      .map((m) => m.symbol);
  });

/** Fair-market prices for every stock, keyed by asset ("AAPL.US"). */
export const stockPrices = () =>
  cached("tickers", 15_000, async () => {
    const all = await bpPublic<Ticker[]>("/api/v1/tickers", { source: "External" });
    const map = new Map<string, Ticker>();
    for (const t of all) if (t.symbol.endsWith(".US_USDC")) map.set(t.symbol.replace(/_USDC$/, ""), t);
    return map;
  });

export const stockKlines = (asset: string, interval: "1h" | "1d" | "1w", days: number) =>
  cached(`klines:${asset}:${interval}:${days}`, 60_000, () =>
    bpPublic<Kline[]>("/api/v1/klines", {
      symbol: `${asset}_USDC`,
      interval,
      startTime: Math.floor(Date.now() / 1000) - days * 86_400,
      source: "External",
    }));

export const rfqSymbol = (asset: string) => `${asset}_USDC_RFQ`;
export const spotSymbol = (asset: string) => `${asset}_USDC`;

// ── Trading & capital (signed, Bluvfi's account) ─────────────────────────────

export type BpSide = "Bid" | "Ask";
export type BpStatus = "Cancelled" | "Expired" | "Filled" | "New" | "PartiallyFilled" | "TriggerPending" | "TriggerFailed";

export interface BpRfq {
  rfqId: string;
  clientId?: number;
  symbol: string;
  side: BpSide;
  price?: string;
  quantity?: string;
  status: BpStatus;
  executionMode: "AwaitAccept" | "Immediate";
  expiryTime: number | string;
  executedQuantity?: string;
  executedQuoteQuantity?: string;
  deferredSettlementQuoteId?: string;
}

export interface BpRfqFill {
  rfqId: string;
  quoteId: string;
  symbol: string;
  side: BpSide;
  fillQuantity?: string;
  fillQuoteQuantity?: string;
  fillPrice: string;
  filledAt: string;
}

/**
 * Submit a stock RFQ that auto-accepts the first quote at or better than
 * `price` (buy: ≤ price, sell: ≥ price). Quantity is in shares — stock RFQs
 * don't support quoteQuantity.
 */
export function submitRfq(o: { asset: string; side: BpSide; quantity: string; price: string; clientId: number }): Promise<BpRfq> {
  return bpSigned<BpRfq>("POST", "/api/v1/rfq", "rfqSubmit", {
    symbol: rfqSymbol(o.asset),
    side: o.side,
    quantity: o.quantity,
    price: o.price,
    executionMode: "Immediate",
    clientId: o.clientId,
  });
}

/** Open RFQs (includes AcceptedBinding / deferred-settlement ones still settling). */
export function getOpenRfq(rfqId: string): Promise<{ rfq: BpRfq; quotes: unknown[] }[]> {
  return bpSigned("GET", "/api/v1/rfqs", "rfqQuery", { rfqId: Number(rfqId) });
}

export function getRfqHistory(rfqId: string): Promise<BpRfq[]> {
  return bpSigned("GET", "/wapi/v1/history/rfq", "rfqHistoryQueryAll", { rfqId });
}

export function getRfqFills(rfqId: string): Promise<BpRfqFill[]> {
  return bpSigned("GET", "/wapi/v1/history/rfq/fill", "rfqFillHistoryQueryAll", { rfqId });
}

export interface BpOrder {
  id: string;
  symbol: string;
  side: BpSide;
  status: string;
  quantity?: string;
  executedQuantity?: string;
  executedQuoteQuantity?: string;
}

/** Spot order-book market order (outside RFQ hours), with a slippage cap. */
export function executeSpotOrder(o: { asset: string; side: BpSide; quantity: string; limitPrice: string; clientId: number }): Promise<BpOrder> {
  return bpSigned<BpOrder>("POST", "/api/v1/order", "orderExecute", {
    symbol: spotSymbol(o.asset),
    side: o.side,
    orderType: "Limit",
    price: o.limitPrice,
    quantity: o.quantity,
    timeInForce: "IOC", // fill what's available at or better than the cap now; never rests on the book
    clientId: o.clientId,
  });
}

export type BpChain = "Base" | "Solana";

export const depositAddress = (blockchain: BpChain) =>
  cached(`deposit:${blockchain}`, 60 * 60_000, () =>
    bpSigned<{ address: string }>("GET", "/wapi/v1/capital/deposit/address", "depositAddressQuery", { blockchain }));

export interface BpDeposit { id: number; transactionHash?: string; fromAddress?: string; symbol: string; quantity: string; status: string; source: string }

export function findDeposit(transactionHash: string): Promise<BpDeposit[]> {
  return bpSigned("GET", "/wapi/v1/capital/deposits", "depositQueryAll", { transactionHash });
}

export interface BpWithdrawal { id: number; status?: string; quantity: string; fee: string; transactionHash?: string }

/**
 * Sends USDC from Bluvfi's Backpack account to the user's wallet. The address
 * must be in the Backpack address book with 2FA disabled, or Backpack refuses
 * (WITHDRAWAL_2FA_REQUIRED) — see the setup notes in the README.
 */
export function withdrawUsdc(o: { address: string; blockchain: BpChain; quantity: string; clientId: string }): Promise<BpWithdrawal> {
  return bpSigned("POST", "/wapi/v1/capital/withdrawals", "withdraw", {
    address: o.address,
    blockchain: o.blockchain,
    quantity: o.quantity,
    symbol: "USDC",
    clientId: o.clientId,
  });
}

export function accountBalances(): Promise<Record<string, { available: string; locked: string; staked: string }>> {
  return bpSigned("GET", "/api/v1/capital", "balanceQuery");
}

// ── Market hours ─────────────────────────────────────────────────────────────

function nyParts(d: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  const isoWeekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[p.weekday];
  return { isoWeekday, date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

function weekdayIn(day: number, start: number, end: number): boolean {
  return start <= end ? day >= start && day <= end : day >= start || day <= end; // cyclic, e.g. 7 → 4
}

function sessionActive(s: MarketSession, now: Date): boolean {
  const { isoWeekday, time } = nyParts(now, s.timezone);
  if (s.startTime < s.endTime) return weekdayIn(isoWeekday, s.startWeekday, s.endWeekday) && time >= s.startTime && time < s.endTime;
  // Crosses midnight (overnight): opens on a start day at startTime, closes the next morning at endTime.
  const prevDay = isoWeekday === 1 ? 7 : isoWeekday - 1;
  return (time >= s.startTime && weekdayIn(isoWeekday, s.startWeekday, s.endWeekday))
    || (time < s.endTime && weekdayIn(prevDay, s.startWeekday, s.endWeekday));
}

function holidayActive(h: MarketHoliday, now: Date): boolean {
  const { date, time } = nyParts(now, h.timezone);
  if (h.date !== date) return false;
  if (!h.startTime || !h.endTime) return true; // full-day closure
  return time >= h.startTime && time <= h.endTime;
}

/** The US-equities session trading right now, or null if the market is closed. */
export async function currentSession(now = new Date()): Promise<MarketSession | null> {
  const [sessions, holidays] = await Promise.all([listMarketSessions(), listMarketHolidays().catch(() => [])]);
  if (holidays.some((h) => h.market === "US_EQUITIES" && holidayActive(h, now))) return null;
  return sessions.find((s) => sessionActive(s, now)) ?? null;
}
