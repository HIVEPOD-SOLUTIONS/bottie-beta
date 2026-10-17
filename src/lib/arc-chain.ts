import { defineChain, type Hex } from "viem";

/**
 * Arc mainnet — Circle's stablecoin L1. USDC is the native gas token, so a
 * user only ever needs USDC here: it pays for the transfer AND the gas.
 * Values match @circle-fin/app-kit's `Arc` chain definition (verified live:
 * eth_chainId 0x13b2, USDC at 0x3600…0000 reports 6 decimals).
 *
 * Note the two decimal scales: native-gas USDC is 18 decimals (that's what
 * `getBalance` returns), while the USDC ERC-20 interface is 6 decimals — the
 * same funds, viewed two ways. Payments use the ERC-20 (6 dp).
 */
const ARC_RPC = "https://rpc.mainnet.arc.io";

/**
 * In the browser, go through our own /api/rpc/arc proxy: ad/privacy blockers block
 * rpc.mainnet.arc.io outright, which breaks Privy's embedded wallet on Arc. Servers use
 * the upstream directly. (NEXT_PUBLIC_API_URL is set for the Capacitor app, whose own
 * origin has no /api.)
 */
const arcRpcUrl =
  typeof window === "undefined"
    ? ARC_RPC
    : `${(process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "") || window.location.origin}/api/rpc/arc`;

export const arcChain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [arcRpcUrl] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

/** USDC's ERC-20 interface on Arc (6 decimals). */
export const ARC_USDC: Hex = "0x3600000000000000000000000000000000000000";

export const arcTxUrl = (hash: string) => `${arcChain.blockExplorers.default.url}/tx/${hash}`;
export const arcAddressUrl = (address: string) => `${arcChain.blockExplorers.default.url}/address/${address}`;
