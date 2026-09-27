/**
 * Coinbase Tokenized Stocks on Base — public reference API, no key required.
 * https://docs.base.org/sdks/tokenized-stocks/overview
 *
 * Read-only reference data only: contract address, symbol, total supply, multiplier and a
 * Chainlink-based NAV/reference value. NOT a live bid/ask, NOT trading/execution/custody, and
 * presence in the list does not imply eligibility — Coinbase restricts these tokens to persons
 * outside the US in eligible jurisdictions.
 */

const BASE = "https://api.coinbase.com/v1/tokenized-stocks";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data?.message ?? `Coinbase tokenized-stocks API ${res.status}`);
  }
  return data as T;
}

export interface BaseStockToken {
  contract_address: string;
  symbol: string;
  name: string;
  decimals: number;
  icon_url?: string;
  total_supply: number;
  isin?: string;
  multiplier: number;
  paused_features?: number[];
  nav_price?: number;
  nav_price_updated_at?: string;
}

/** Hours after which a nav_price is treated as stale — feeds hold their last value outside market hours. */
const NAV_STALE_HOURS = 20;

function withDerived(t: BaseStockToken) {
  const updatedAt = t.nav_price_updated_at ? new Date(t.nav_price_updated_at) : null;
  const ageHours = updatedAt ? (Date.now() - updatedAt.getTime()) / 3_600_000 : null;
  return {
    ...t,
    // total_supply is token units, not shares — multiply by the multiplier to get shares.
    totalSharesEquivalent: t.total_supply != null && t.multiplier != null ? t.total_supply * t.multiplier : null,
    navPriceAgeHours: ageHours,
    navPriceStale: ageHours == null ? null : ageHours > NAV_STALE_HOURS,
  };
}

export async function listBaseStocks(query?: string) {
  const data = await get<{ tokens?: BaseStockToken[] }>("");
  let tokens = (data.tokens ?? []).map(withDerived);
  if (query) {
    const q = query.trim().toLowerCase();
    tokens = tokens.filter((t) => t.symbol?.toLowerCase().includes(q) || t.name?.toLowerCase().includes(q));
  }
  return { tokens, count: tokens.length };
}

export async function getBaseStock(symbolOrAddress: string) {
  const { tokens } = await listBaseStocks();
  const q = symbolOrAddress.trim().toLowerCase();
  const token = tokens.find(
    (t) => t.symbol?.toLowerCase() === q || t.contract_address?.toLowerCase() === q,
  );
  if (!token) throw new Error(`No Base tokenized stock found for "${symbolOrAddress}"`);
  return token;
}

export function getBaseStocksChains() {
  return get<{ chains?: Array<{ chain_id?: string | number; chain_name?: string; contract_address?: string }> }>(
    "/chains",
  );
}

export async function getBaseStockTotalSupply(contractAddress: string) {
  return get<{ total_supply?: number }>(`/total-supply/${contractAddress}`);
}
