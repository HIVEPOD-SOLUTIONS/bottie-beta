/**
 * dYdX Chain v4 — Indexer REST API client (read-only, no auth required).
 *
 * All data comes from the public Indexer at https://indexer.dydx.trade/v4.
 * Write operations (place/cancel orders) require @dydxprotocol/v4-client-js
 * and user wallet signing — those are intentionally out-of-scope here.
 *
 * All paths have been verified live against the Indexer.
 */

const BASE = "https://indexer.dydx.trade/v4";

async function get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`dYdX ${url.pathname}: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// ── Market data ───────────────────────────────────────────────────────────────

export function listPerpetualMarkets() {
  return get<{ markets: Record<string, unknown> }>("/perpetualMarkets");
}

export function getPerpetualMarket(ticker: string) {
  return get<{ markets: Record<string, unknown> }>(`/perpetualMarkets`, { ticker });
}

export function getOrderbook(ticker: string) {
  return get<{ asks: unknown[]; bids: unknown[] }>(`/orderbooks/perpetualMarket/${encodeURIComponent(ticker)}`);
}

export function getCandles(
  ticker: string,
  resolution: string,
  opts?: { limit?: number; fromISO?: string; toISO?: string }
) {
  return get<{ candles: unknown[] }>(`/candles/perpetualMarkets/${encodeURIComponent(ticker)}`, {
    resolution,
    limit: opts?.limit,
    fromISO: opts?.fromISO,
    toISO: opts?.toISO,
  });
}

export function getMarketTrades(ticker: string, limit?: number) {
  return get<{ trades: unknown[] }>(`/trades/perpetualMarket/${encodeURIComponent(ticker)}`, { limit });
}

// Stats are embedded in the perpetualMarkets response (volume24H, trades24H, priceChange24H, openInterest)
export function getMarketStats(ticker: string) {
  return get<{ markets: Record<string, unknown> }>(`/perpetualMarkets`, { ticker });
}

// Historical per-market funding rates (different from per-user funding payments)
export function getHistoricalFunding(ticker: string, opts?: { limit?: number; effectiveBeforeOrAt?: string }) {
  return get<{ historicalFunding: unknown[] }>(`/historicalFunding/${encodeURIComponent(ticker)}`, {
    limit: opts?.limit,
    effectiveBeforeOrAt: opts?.effectiveBeforeOrAt,
  });
}

export function getSparklines(timePeriod: "ONE_DAY" | "SEVEN_DAYS" = "ONE_DAY") {
  return get<Record<string, unknown[]>>(`/sparklines`, { timePeriod });
}

// ── Account / subaccount data ─────────────────────────────────────────────────

export function getAccount(address: string) {
  return get<unknown>(`/addresses/${encodeURIComponent(address)}`);
}

export function getSubaccount(address: string, subaccountNumber: number) {
  return get<unknown>(`/addresses/${encodeURIComponent(address)}/subaccountNumber/${subaccountNumber}`);
}

export function getPerpetualPositions(
  address: string,
  subaccountNumber: number,
  status?: string,
  ticker?: string
) {
  return get<{ positions: unknown[] }>(`/perpetualPositions`, {
    address,
    subaccountNumber,
    status,
    ticker,
  });
}

export function getAssetPositions(address: string, subaccountNumber: number) {
  return get<{ positions: unknown[] }>(`/assetPositions`, { address, subaccountNumber });
}

// ── Orders & fills ────────────────────────────────────────────────────────────

export function getOrders(
  address: string,
  subaccountNumber: number,
  opts?: { status?: string; ticker?: string; side?: string; limit?: number }
) {
  return get<unknown[]>(`/orders`, {
    address,
    subaccountNumber,
    status: opts?.status,
    ticker: opts?.ticker,
    side: opts?.side,
    limit: opts?.limit,
  });
}

export function getOrder(orderId: string) {
  return get<unknown>(`/orders/${encodeURIComponent(orderId)}`);
}

export function getFills(
  address: string,
  subaccountNumber: number,
  opts?: { ticker?: string; limit?: number; createdBeforeOrAt?: string }
) {
  return get<{ fills: unknown[] }>(`/fills`, {
    address,
    subaccountNumber,
    ticker: opts?.ticker,
    limit: opts?.limit,
    createdBeforeOrAt: opts?.createdBeforeOrAt,
  });
}

// ── Transfers, PnL, funding payments ─────────────────────────────────────────

export function getTransfers(
  address: string,
  subaccountNumber: number,
  opts?: { limit?: number; createdBeforeOrAt?: string }
) {
  return get<{ transfers: unknown[] }>(`/transfers`, {
    address,
    subaccountNumber,
    limit: opts?.limit,
    createdBeforeOrAt: opts?.createdBeforeOrAt,
  });
}

export function getHistoricalPnl(
  address: string,
  subaccountNumber: number,
  opts?: { limit?: number; createdBeforeOrAt?: string }
) {
  return get<{ historicalPnl: unknown[] }>(`/historical-pnl`, {
    address,
    subaccountNumber,
    limit: opts?.limit,
    createdBeforeOrAt: opts?.createdBeforeOrAt,
  });
}

// Correct endpoint is /fundingPayments (not /funding)
export function getFundingPayments(
  address: string,
  subaccountNumber: number,
  opts?: { ticker?: string; limit?: number }
) {
  return get<{ fundingPayments: unknown[] }>(`/fundingPayments`, {
    address,
    subaccountNumber,
    ticker: opts?.ticker,
    limit: opts?.limit,
  });
}

// ── Trading rewards ───────────────────────────────────────────────────────────

export function getHistoricalBlockTradingRewards(
  address: string,
  opts?: { limit?: number; startingBeforeOrAt?: string }
) {
  return get<{ rewards: unknown[] }>(`/historicalBlockTradingRewards/${encodeURIComponent(address)}`, {
    limit: opts?.limit,
    startingBeforeOrAt: opts?.startingBeforeOrAt,
  });
}

export function getHistoricalTradingRewardAggregations(
  address: string,
  opts?: { period?: string; limit?: number; startingBeforeOrAt?: string }
) {
  return get<unknown>(`/historicalTradingRewardAggregations/${encodeURIComponent(address)}`, {
    period: opts?.period,
    limit: opts?.limit,
    startingBeforeOrAt: opts?.startingBeforeOrAt,
  });
}

// ── Megavault ─────────────────────────────────────────────────────────────────

export function getMegavaultPositions() {
  return get<unknown>(`/vault/v1/megavault/positions`);
}

// resolution must be "day" or "hour" (lowercase)
export function getMegavaultHistoricalPnl(opts?: { resolution?: "day" | "hour"; limit?: number }) {
  return get<unknown>(`/vault/v1/megavault/historicalPnl`, {
    resolution: opts?.resolution,
    limit: opts?.limit,
  });
}

export function getMegavaultOwnerShares(address: string) {
  return get<unknown>(`/vault/v1/megavault/ownerShares/${encodeURIComponent(address)}`);
}

export function getMegavaultHistoricalOwnerShares(
  address: string,
  opts?: { limit?: number; createdBeforeOrAt?: string }
) {
  return get<unknown>(`/vault/v1/megavault/historicalOwnerShares/${encodeURIComponent(address)}`, {
    limit: opts?.limit,
    createdBeforeOrAt: opts?.createdBeforeOrAt,
  });
}

export function getVaultPositions() {
  return get<unknown>(`/vault/v1/vaults/positions`);
}

// ── Chain / health ────────────────────────────────────────────────────────────

export function getBlockHeight() {
  return get<{ height: string; time: string }>(`/height`);
}

export function getServerTime() {
  return get<{ iso: string; epoch: number }>(`/time`);
}

// ── Parent subaccount (cross-margin aggregate view) ───────────────────────────

export function getParentSubaccount(address: string, parentSubaccountNumber: number) {
  return get<unknown>(`/addresses/${encodeURIComponent(address)}/parentSubaccountNumber/${parentSubaccountNumber}`);
}

export function getPerpetualPositionsParent(address: string, parentSubaccountNumber: number, opts?: { status?: string; ticker?: string; limit?: number }) {
  return get<{ positions: unknown[] }>(`/perpetualPositions/parentSubaccountNumber`, { address, parentSubaccountNumber, status: opts?.status, ticker: opts?.ticker, limit: opts?.limit });
}

export function getAssetPositionsParent(address: string, parentSubaccountNumber: number) {
  return get<{ positions: unknown[] }>(`/assetPositions/parentSubaccountNumber`, { address, parentSubaccountNumber });
}

export function getOrdersParent(address: string, parentSubaccountNumber: number, opts?: { status?: string; ticker?: string; side?: string; limit?: number }) {
  return get<unknown[]>(`/orders/parentSubaccountNumber`, { address, parentSubaccountNumber, status: opts?.status, ticker: opts?.ticker, side: opts?.side, limit: opts?.limit });
}

export function getFundingPaymentsParent(address: string, parentSubaccountNumber: number, opts?: { ticker?: string; limit?: number }) {
  return get<{ fundingPayments: unknown[] }>(`/fundingPayments/parentSubaccount`, { address, parentSubaccountNumber, ticker: opts?.ticker, limit: opts?.limit });
}

export function getHistoricalPnlParent(address: string, parentSubaccountNumber: number, opts?: { limit?: number; createdBeforeOrAt?: string }) {
  return get<{ historicalPnl: unknown[] }>(`/historical-pnl/parentSubaccountNumber`, { address, parentSubaccountNumber, limit: opts?.limit, createdBeforeOrAt: opts?.createdBeforeOrAt });
}

export function getTransfersParent(address: string, parentSubaccountNumber: number, opts?: { limit?: number; createdBeforeOrAt?: string }) {
  return get<{ transfers: unknown[] }>(`/transfers/parentSubaccountNumber`, { address, parentSubaccountNumber, limit: opts?.limit, createdBeforeOrAt: opts?.createdBeforeOrAt });
}

// ── PnL (hourly buckets) ──────────────────────────────────────────────────────

export function getPnl(address: string, subaccountNumber: number, opts?: { limit?: number; createdBeforeOrAt?: string }) {
  return get<{ pnl: unknown[] }>(`/pnl`, { address, subaccountNumber, limit: opts?.limit, createdBeforeOrAt: opts?.createdBeforeOrAt });
}

export function getPnlParent(address: string, parentSubaccountNumber: number, opts?: { limit?: number; createdBeforeOrAt?: string }) {
  return get<{ pnl: unknown[] }>(`/pnl/parentSubaccountNumber`, { address, parentSubaccountNumber, limit: opts?.limit, createdBeforeOrAt: opts?.createdBeforeOrAt });
}

// ── Trade history ─────────────────────────────────────────────────────────────

export function getTradeHistory(address: string, subaccountNumber: number, opts?: { ticker?: string; limit?: number }) {
  return get<{ tradeHistory: unknown[] }>(`/tradeHistory`, { address, subaccountNumber, ticker: opts?.ticker, limit: opts?.limit });
}

export function getTradeHistoryParent(address: string, parentSubaccountNumber: number, opts?: { ticker?: string; limit?: number }) {
  return get<{ tradeHistory: unknown[] }>(`/tradeHistory/parentSubaccountNumber`, { address, parentSubaccountNumber, ticker: opts?.ticker, limit: opts?.limit });
}

// ── Transfers between two addresses ──────────────────────────────────────────

export function getTransfersBetween(
  sourceAddress: string,
  sourceSubaccountNumber: number,
  recipientAddress: string,
  recipientSubaccountNumber: number,
) {
  return get<{ transfersSubset: unknown[]; totalNetTransfers: string }>(`/transfers/between`, {
    sourceAddress,
    sourceSubaccountNumber,
    recipientAddress,
    recipientSubaccountNumber,
  });
}

// ── Trader search ─────────────────────────────────────────────────────────────

export function searchTrader(searchParam: string) {
  return get<{ result: unknown }>(`/trader/search`, { searchParam });
}

// ── Vault historical PnL ──────────────────────────────────────────────────────

export function getVaultsHistoricalPnl(opts?: { resolution?: "day" | "hour"; limit?: number }) {
  return get<{ vaultsPnl: unknown[] }>(`/vault/v1/vaults/historicalPnl`, { resolution: opts?.resolution, limit: opts?.limit });
}

// ── Compliance ────────────────────────────────────────────────────────────────

// Returns { restricted: boolean } — simple geo block check
export function screenAddress(address: string) {
  return get<{ restricted: boolean }>(`/screen`, { address });
}

// Returns { status, reason, updatedAt } — full compliance status
export function getComplianceScreen(address: string) {
  return get<{ status: string; reason: string | null; updatedAt: string }>(`/compliance/screen/${encodeURIComponent(address)}`);
}

// ── Affiliates ────────────────────────────────────────────────────────────────

// Referral metadata for an address: referralCode, isVolumeEligible, isAffiliate
export function getAffiliateMetadata(address: string) {
  return get<{ referralCode: string; isVolumeEligible: boolean; isAffiliate: boolean }>(`/affiliates/metadata`, { address });
}

// Resolve a referral code → the affiliate's dYdX address
export function getAffiliateAddressByReferralCode(referralCode: string) {
  return get<{ address: string }>(`/affiliates/address`, { referralCode });
}

// Paginated leaderboard snapshot of top affiliates by referred volume
export function getAffiliatesSnapshot(opts?: { limit?: number; offset?: number; sortByAffiliateEarning?: boolean }) {
  return get<{ affiliateList: unknown[] }>(`/affiliates/snapshot`, {
    limit: opts?.limit,
    offset: opts?.offset,
    sortByAffiliateEarning: opts?.sortByAffiliateEarning !== undefined ? String(opts.sortByAffiliateEarning) : undefined,
  });
}
