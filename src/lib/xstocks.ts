const BASE = "https://api.xstocks.fi/api/v2";

function apiKey() {
  return process.env.XSTOCKS_API_KEY ?? "";
}

function authHeaders() {
  return { "x-api-key": apiKey(), "Content-Type": "application/json" };
}

async function get<T>(path: string, auth = false): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers["x-api-key"] = apiKey();
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`xStocks ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`xStocks ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ── Public: Assets ────────────────────────────────────────────────────────────

export function listAssets() {
  return get("/public/assets");
}

export function getAsset(symbol: string) {
  return get(`/public/assets/${symbol}`);
}

export function getAssetMultiplier(symbol: string) {
  return get(`/public/assets/${symbol}/multiplier`);
}

export function getAssetMultiplierHistory(symbol: string, params?: { from?: string; to?: string; limit?: number }) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : "";
  return get(`/public/assets/${symbol}/multiplier/history${qs}`);
}

export function getAssetPriceData(symbol: string, params?: { from?: string; to?: string; interval?: string }) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : "";
  return get(`/public/assets/${symbol}/price-data${qs}`);
}

export function getAssetCirculatingSupply(symbol: string) {
  return get(`/public/assets/${symbol}/circulating-supply`);
}

export function getAssetTotalSupply(symbol: string) {
  return get(`/public/assets/${symbol}/total-supply`);
}

// ── Public: Proof of Reserves ─────────────────────────────────────────────────

export function listProofOfReserves() {
  return get("/public/proof-of-reserves");
}

export function getProofOfReserves(symbol: string) {
  return get(`/public/proof-of-reserves/${symbol}`);
}

// ── Public: Oracles ───────────────────────────────────────────────────────────

export function listOracles() {
  return get("/public/oracles");
}

export function getOracle(symbol: string) {
  return get(`/public/oracles/${symbol}`);
}

// ── Public: System ────────────────────────────────────────────────────────────

export function getSystemStatus(symbol: string) {
  return get(`/public/system/status/${symbol}`);
}

export function getSystemWallets() {
  return get("/public/system/wallets");
}

// ── Public: Corporate Actions ─────────────────────────────────────────────────

export function getCorporateActionsHistory(params?: { symbol?: string; from?: string; to?: string }) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : "";
  return get(`/public/corporate-actions/history${qs}`);
}

export function getCorporateActionsUpcoming(params?: { symbol?: string }) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : "";
  return get(`/public/corporate-actions/upcoming${qs}`);
}

// ── Public: Bridges ───────────────────────────────────────────────────────────

export function listPublicBridges() {
  return get("/public/bridges");
}

// ── Client ────────────────────────────────────────────────────────────────────

export function getRegisteredWallets() {
  return get("/client/registered-wallets", true);
}

export function getClientLimits() {
  return get("/client/limits", true);
}

export function getClientUsage() {
  return get("/client/usage", true);
}

export function createWhitelistChallenge(body: { walletAddress: string; chain: string }) {
  return post("/client/registered-wallets/whitelist/challenge", body);
}

export function submitWhitelist(body: { walletAddress: string; chain: string; signature: string; challenge: string }) {
  return post("/client/registered-wallets/whitelist", body);
}

// ── Trades ────────────────────────────────────────────────────────────────────

export function getTradesSummary() {
  return get("/trades/summary", true);
}

export function listTrades(params?: { symbol?: string; type?: string; status?: string; from?: string; to?: string; limit?: number; offset?: number }) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : "";
  return get(`/trades${qs}`, true);
}

export function getTrade(id: string) {
  return get(`/trades/${id}`, true);
}

// ── xChange Trades ────────────────────────────────────────────────────────────

export function createXchangeRfq(body: {
  symbol: string;
  side: "buy" | "sell";
  quantity?: number;
  notional?: number;
  walletAddress?: string;
  chain?: string;
}) {
  return post("/trades/xchange/rfq", body);
}

export function createXchangeRfqSoft(body: {
  symbol: string;
  side: "buy" | "sell";
  quantity?: number;
  notional?: number;
}) {
  return post("/trades/xchange/rfq/soft", body);
}

export function getXchangeQuote(id: string) {
  return get(`/trades/xchange/quote/${id}`, true);
}

export function listXchangeAssets() {
  return get("/trades/xchange/assets", true);
}

export function getXchangeAsset(identifier: string) {
  return get(`/trades/xchange/assets/${identifier}`, true);
}

// ── Market Trades ─────────────────────────────────────────────────────────────

export function getMarketRedemptionWallets() {
  return get("/trades/market/redemption/sweeping-wallets", true);
}

export function getMarketIssuanceWallets() {
  return get("/trades/market/issuance/sweeping-wallets", true);
}

export function getMarketFees() {
  return get("/trades/market/fees", true);
}

// ── InKind Trades ─────────────────────────────────────────────────────────────

export function getInkindSweepingWallets() {
  return get("/trades/inkind/sweeping-wallets", true);
}

// ── Bridges (Authenticated) ───────────────────────────────────────────────────

export function listBridges() {
  return get("/bridges", true);
}

export function getBridgeSweepingWallets() {
  return get("/bridges/sweeping-wallets", true);
}
