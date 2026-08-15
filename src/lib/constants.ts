export const DEFAULT_CHAIN_ID = 8453; // Base mainnet
export const SUPPORTED_CHAIN_IDS = [8453] as const;

// Base mainnet token addresses
export const BASE_TOKENS: Record<string, `0x${string}`> = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
};

export const BASE_TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6,
  WETH: 18,
  ETH: 18,
};

// Circle Gateway Nanopayments — Base mainnet
export const CIRCLE_GATEWAY_CHAIN = "base" as const;
// CAIP-2 network identifier for Base mainnet (chain ID 8453)
export const CIRCLE_GATEWAY_NETWORK = "eip155:8453";
export const CIRCLE_GATEWAY_FACILITATOR_URL =
  "https://gateway-api.circle.com";
// Addresses sourced from @circle-fin/x402-batching CHAIN_CONFIGS
export const CIRCLE_BASE_USDC =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const CIRCLE_BASE_GATEWAY_WALLET =
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;


export const ALLOWANCE_HOLDER =
  "0x0000000000001fF3684f28c67538d4D072C22734" as const;

/** Token logos keyed by token symbol */
export const TOKEN_LOGOS: Record<string, string> = {
  WETH: "/tokens/eth.png", ETH: "/tokens/eth.png",
  USDC: "/tokens/usdc.png", USDT: "/tokens/usdt.png",
  cbBTC: "/tokens/btc.png", EURC: "/tokens/eur.png",
};

/** Friendly display names for token symbols */
export const TOKEN_DISPLAY_NAMES: Record<string, string> = {
  WETH: "ETH", cbBTC: "BTC", EURC: "EUR",
};

export const NARRATION_CACHE_KEY = "bluvfi:narration-cache";

/** Known token addresses on Base mainnet */
export const TOKEN_ADDRESSES: Record<string, string> = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
};

export const SYMBOL_TO_COINGECKO: Record<string, string> = {
  usdc: "usd-coin",
  weth: "ethereum",
  eth: "ethereum",
  cbbtc: "coinbase-wrapped-btc",
  eurc: "euro-coin",
  xaut: "tether-gold",
  usdt: "tether",
};

// ── Legacy stubs — kept for backward-compat with old vault components ─────────
export const VAULT_DISPLAY_ORDER = [] as const;
export const VAULT_FRIENDLY_NAMES: Record<string, string> = {};
export const VAULT_ACCENTS: Record<string, { color: string; bg: string; border: string }> = {};
export const VAULT_LOGOS: Record<string, string> = {};
export const BILL_PROVIDERS: Record<string, { name: string; category: string; defaultAmount: number; logo: string; payeeAddress: string }> = {};
export const INVESTMENT_OPTIONS: Record<string, { name: string; type: string; currentPriceUsd: number; description: string; available: boolean }> = {};
