import { listPaymentMethods } from "@/lib/cryptorefills";
import { ADDRESS_BASED_PAYMENT_METHODS } from "@/lib/bitrefill-mcp";

/**
 * Every crypto token Bluvfi's providers can move, with who supports it — the coin list behind the app's
 * price screen (/api/prices/supported). Additive: the dashboard ticker and /api/prices are untouched.
 *
 * Where each list comes from:
 *   - Cryptorefills: queried live (its payment_vias endpoint — the coins a user can pay with from a wallet).
 *   - Bitrefill: the payment-method keys the app already accepts (ADDRESS_BASED_PAYMENT_METHODS), mapped to tickers.
 *     Bitrefill offers these per product, but this set is what Bluvfi creates invoices with.
 *   - Wallet / Circle / Privy funding, Nosana, Doma, Backpack, XRPL: the coins those integrations are built around.
 *   - GetEquity is fiat-only (NGN, USD, KES…), so it adds no crypto.
 */

/** Bitrefill payment-method key → CoinMarketCap ticker. Keys not listed (e.g. brusd_*, lightning) are skipped / folded in. */
const BITREFILL_COIN: Record<string, string> = {
  ethereum: "ETH", eth_base: "ETH", eth_arbitrum: "ETH",
  solana: "SOL", sui: "SUI", ton: "TON", ark: "ARK",
  bitcoin: "BTC", lightning: "BTC",
  litecoin: "LTC", dogecoin: "DOGE", dash: "DASH",
  bnb_bsc: "BNB", xrp: "XRP",
};

function bitrefillCoins(): string[] {
  const out = new Set<string>();
  for (const key of ADDRESS_BASED_PAYMENT_METHODS) {
    const mapped = BITREFILL_COIN[key];
    if (mapped) { out.add(mapped); continue; }
    const stable = /^(usdc|usdt)_/.exec(key);
    if (stable) out.add(stable[1].toUpperCase());
  }
  // The app also pays Bitrefill in USDC on Base / Solana / Ethereum / Polygon / Arbitrum.
  out.add("USDC");
  return [...out];
}

/** Tickers that don't map 1:1 from a provider's own coin name to CoinMarketCap's. */
const NORMALIZE: Record<string, string> = { MATIC: "POL", BITCOIN: "BTC", ETHEREUM: "ETH", TETHER: "USDT" };
const normalize = (s: string) => {
  const up = s.trim().toUpperCase();
  return NORMALIZE[up] ?? up;
};

export interface SupportedCoin {
  symbol: string;
  providers: string[];
}

async function cryptorefillsCoins(): Promise<string[]> {
  try {
    const methods = await listPaymentMethods();
    return [...new Set(methods.map((m) => normalize(m.coin)).filter((c) => /^[A-Z0-9]{1,12}$/.test(c)))];
  } catch {
    // Partner API not configured or down: its gasless USDC is still supported.
    return ["USDC"];
  }
}

let cache: { at: number; coins: SupportedCoin[] } | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function getSupportedCoins(): Promise<SupportedCoin[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.coins;

  const byProvider: Record<string, string[]> = {
    "Bluvfi Wallet": ["ETH", "USDC", "USDT", "SOL", "POL"],
    Bitrefill: bitrefillCoins(),
    Cryptorefills: await cryptorefillsCoins(),
    "Circle (USDC bridge)": ["USDC"],
    Backpack: ["USDC"],
    Nosana: ["NOS"],
    Doma: ["ETH", "USDC"],
    XRPL: ["XRP"],
  };

  const map = new Map<string, Set<string>>();
  for (const [provider, coins] of Object.entries(byProvider)) {
    for (const c of coins) {
      const sym = normalize(c);
      if (!map.has(sym)) map.set(sym, new Set());
      map.get(sym)!.add(provider);
    }
  }
  const coins = [...map.entries()].map(([symbol, providers]) => ({ symbol, providers: [...providers] }));
  cache = { at: Date.now(), coins };
  return coins;
}
