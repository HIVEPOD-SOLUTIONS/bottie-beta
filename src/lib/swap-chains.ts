/**
 * Chains bluvfi-xrpl can swap FROM besides XRPL — one registry shared by the
 * server (pricing, swap creation) and the browser (checkout UI, wallet
 * signing). Nothing here touches the database or secrets.
 *
 *   - "deposit" chains (NEAR Intents): the service returns a deposit address
 *     the payment is sent to. Zcash and Hyperliquid are paid from the user's
 *     own wallet/account; Robinhood Chain ETH can also be sent straight from
 *     the Bluvfi wallet (it is an EVM chain the Privy wallet can sign on).
 *   - "route" chains (LI.FI): the service returns an approval + transaction the
 *     Bluvfi wallet signs on that chain (Arc, Tempo); the hash is reported back.
 *
 * Chain ids, RPCs and explorers below were checked against LI.FI's live
 * GET /v1/chains (Arc 5042, Tempo 4217, Robinhood Chain 4663).
 */

import { defineChain } from "viem";
import { arcChain } from "@/lib/arc-chain";

export type SwapChain = "zcash" | "hyperliquid" | "arc" | "robinhood" | "tempo";
export const SWAP_CHAINS: readonly SwapChain[] = ["arc", "tempo", "robinhood", "zcash", "hyperliquid"];

export function isSwapChain(v: unknown): v is SwapChain {
  return typeof v === "string" && (SWAP_CHAINS as readonly string[]).includes(v);
}

/** Robinhood Chain mainnet (Arbitrum Orbit). Native ETH pays gas. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: "https://robin.etherscan.io" } },
});

/**
 * Tempo mainnet. There is no volatile gas token: fees are paid in a USD
 * stablecoin. LI.FI lists PathUSD as the "native" asset, so the wallet needs a
 * little stablecoin on top of what it spends.
 */
export const tempoChain = defineChain({
  id: 4217,
  name: "Tempo",
  nativeCurrency: { name: "PathUSD", symbol: "USD", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.tempo.xyz"] } },
  blockExplorers: { default: { name: "Tempo Explorer", url: "https://explore.tempo.xyz" } },
});

/** USDC.e (Stargate-bridged USDC) on Tempo — what bluvfi-xrpl's tempo route spends. 6 decimals. */
export const TEMPO_USDCE = "0x20C000000000000000000000b9537d11c60E8b50" as const;

export interface SwapChainMeta {
  label: string;
  icon: string;
  /** What the user pays, e.g. "ZEC", "USDC", "ETH". */
  symbol: string;
  /** Smallest-unit decimals bluvfi-xrpl counts the origin amount in. */
  decimals: number;
  kind: "deposit" | "route";
  /** EVM chain the Bluvfi (Privy) wallet can pay from, if any. */
  wallet: { chainId: number; token: `0x${string}` | "native"; tokenDecimals: number } | null;
  /** True when the user must type their own refund address (no Bluvfi wallet on that chain). */
  needsRefundAddress: boolean;
  refundPattern: RegExp;
  refundHint: string;
  refundPlaceholder: string;
  howToPay: string;
  explorerTx: (hash: string) => string | null;
}

const EVM = /^0x[0-9a-fA-F]{40}$/;

export const SWAP_CHAIN_META: Record<SwapChain, SwapChainMeta> = {
  arc: {
    label: "Arc",
    icon: "🟣",
    symbol: "USDC",
    decimals: 6,
    kind: "route",
    wallet: { chainId: arcChain.id, token: "0x3600000000000000000000000000000000000000", tokenDecimals: 6 },
    needsRefundAddress: false,
    refundPattern: EVM,
    refundHint: "your Bluvfi wallet address",
    refundPlaceholder: "",
    howToPay: "Paid from your Bluvfi wallet's USDC on Arc — just confirm. USDC also covers Arc's network fee.",
    explorerTx: (h) => `https://explorer.arc.io/tx/${h}`,
  },
  tempo: {
    label: "Tempo",
    icon: "⚡",
    symbol: "USDC.e",
    decimals: 6,
    kind: "route",
    wallet: { chainId: tempoChain.id, token: TEMPO_USDCE, tokenDecimals: 6 },
    needsRefundAddress: false,
    refundPattern: EVM,
    refundHint: "your Bluvfi wallet address",
    refundPlaceholder: "",
    howToPay: "Paid from your Bluvfi wallet's USDC.e on Tempo — just confirm. Keep a little extra stablecoin on Tempo for the network fee.",
    explorerTx: (h) => `https://explore.tempo.xyz/tx/${h}`,
  },
  robinhood: {
    label: "Robinhood Chain",
    icon: "🪶",
    symbol: "ETH",
    decimals: 18,
    kind: "deposit",
    wallet: { chainId: robinhoodChain.id, token: "native", tokenDecimals: 18 },
    needsRefundAddress: false,
    refundPattern: EVM,
    refundHint: "an 0x address on Robinhood Chain",
    refundPlaceholder: "Refund address (0x…) — defaults to your Bluvfi wallet",
    howToPay: "Send ETH on Robinhood Chain — from your Bluvfi wallet in one tap, or from any wallet to the address shown.",
    explorerTx: (h) => `https://robin.etherscan.io/tx/${h}`,
  },
  zcash: {
    label: "Zcash",
    icon: "🛡️",
    symbol: "ZEC",
    decimals: 8,
    kind: "deposit",
    wallet: null,
    needsRefundAddress: true,
    // Transparent addresses only — NEAR Intents refunds to t-addresses (t1 P2PKH / t3 P2SH).
    refundPattern: /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/,
    refundHint: "a transparent Zcash address (starts with t1 or t3)",
    refundPlaceholder: "Your Zcash address (t1…)",
    howToPay: "Send ZEC from your own Zcash wallet (transparent send).",
    explorerTx: () => null,
  },
  hyperliquid: {
    label: "Hyperliquid",
    icon: "🌊",
    symbol: "USDC",
    decimals: 8,
    kind: "deposit",
    wallet: null,
    needsRefundAddress: true,
    refundPattern: EVM,
    refundHint: "your Hyperliquid account address (0x…)",
    refundPlaceholder: "Your Hyperliquid address (0x…)",
    howToPay: "Send USDC from your Hyperliquid spot balance (Send → paste the address).",
    explorerTx: () => null,
  },
};

/** NEAR Intents enforces a minimum bridge amount; the same pre-filter the XRP flow uses. */
export const MIN_DEPOSIT_SWAP_USD = 3.2;

/**
 * Chains offered at the Bitrefill checkout. Tempo is here too (paid from the
 * Bluvfi wallet like Arc), which works for every product — unlike Bitrefill's
 * own usdc_tempo/usdt_tempo, which only some products accept.
 */
export const BITREFILL_SWAP_CHAINS: readonly SwapChain[] = ["arc", "tempo", "robinhood", "zcash", "hyperliquid"];
/** Chains that can top up the Bluvfi wallet on Base for Cryptorefills, Backpack and Doma. */
export const TOPUP_SWAP_CHAINS: readonly SwapChain[] = SWAP_CHAINS;
