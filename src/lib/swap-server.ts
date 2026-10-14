/**
 * Server-side pricing and creation of bluvfi-xrpl swaps from Zcash,
 * Hyperliquid, Arc, Robinhood Chain or Tempo into a destination asset at a
 * recipient address. Shared by Bitrefill checkout (chain-purchase.ts) and
 * wallet top-ups for Cryptorefills / Backpack / Doma (chain-topup.ts).
 *
 * Pricing:
 *   - deposit chains (NEAR Intents): EXACT_OUTPUT quote → origin amount needed.
 *   - route chains (LI.FI, EXACT_INPUT only): quote a probe input worth the
 *     target in USD, then scale the input by how much of the target the
 *     route's guaranteed floor delivers. Route chains' origin assets are all
 *     USD stablecoins (Arc USDC, Tempo USDC.e), so the probe is exact in USD.
 *
 * A little headroom is added on top, and if bluvfi-xrpl's own guarantee check
 * refuses (422 — the fresh quote's floor is below the target) it is retried
 * once with more. bluvfi-xrpl never under-pays; a refusal costs nothing.
 */

import { createWalletRequest, getQuote, type XrplWallet } from "@/lib/xrplBackend";
import { USDC_DESTINATION_ASSET, isAmountTooLowError } from "@/lib/xrp-purchase";
import { SWAP_CHAIN_META, type SwapChain } from "@/lib/swap-chains";

export interface SwapDestination {
  /** NEAR Intents assetId (deposit chains). */
  nearAsset: string;
  /** LI.FI chain id and token (route chains). */
  lifiChain: string;
  lifiToken: string;
  /** Smallest-unit decimals of the destination asset. */
  decimals: number;
}

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const BASE_USDC_DEST: SwapDestination = {
  nearAsset: USDC_DESTINATION_ASSET.usdc_base,
  lifiChain: "8453",
  lifiToken: BASE_USDC,
  decimals: 6,
};

/** Native ETH on Base (NEAR assetId confirmed against GET /v0/tokens). */
export const BASE_ETH_DEST: SwapDestination = {
  nearAsset: "nep141:base.omft.near",
  lifiChain: "8453",
  lifiToken: "0x0000000000000000000000000000000000000000",
  decimals: 18,
};

const BUFFERS = [1.01, 1.025];

export function errStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

export function isChainDisabledError(err: unknown): boolean {
  return errStatus(err) === 400 && /not available|not enabled|disabled/i.test(err instanceof Error ? err.message : String(err));
}

/** Atomic → decimal string, rounded UP so the user never sends less than needed. */
export function atomicToDecimalCeil(atomic: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = atomic / base;
  const frac = (atomic % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Multiplies an atomic amount by a float factor, rounding up (factor kept to 1e-6 precision). */
function scaleUp(atomic: bigint, factor: number): bigint {
  const ppm = BigInt(Math.ceil(factor * 1_000_000));
  return (atomic * ppm + 999_999n) / 1_000_000n;
}

/** Messages that are safe to show the user (and the AI) as-is. */
export function swapUserError(err: unknown, chain: SwapChain, what = "this payment"): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const { label, refundHint } = SWAP_CHAIN_META[chain];
  if (isChainDisabledError(err)) return new Error(`Paying with ${label} isn't available right now. Please choose a different payment method.`);
  if (errStatus(err) === 400 && /refund/i.test(raw)) return new Error(`That refund address doesn't look right — it must be ${refundHint}.`);
  if (isAmountTooLowError(err)) return new Error(`The amount is too low to pay with ${label}. Please use a larger amount or another payment method.`);
  return new Error(`Couldn't get a price for ${what} with ${label} right now — please try again in a few minutes.`);
}

/** Atomic origin amount that covers `atomicTarget` of the destination, before headroom. */
export async function priceSwap(opts: {
  chain: SwapChain;
  atomicTarget: string;
  /** USD value of the target — the route-chain probe size. */
  targetUsd: number;
  dest: SwapDestination;
  recipient: string;
  privyDid: string;
}): Promise<bigint> {
  const meta = SWAP_CHAIN_META[opts.chain];
  if (meta.kind === "route") {
    const probe = BigInt(Math.max(1, Math.round(opts.targetUsd * 10 ** meta.decimals)));
    const q = await getQuote({
      swapType: "EXACT_INPUT",
      chain: opts.chain,
      amount: probe.toString(),
      destinationChain: opts.dest.lifiChain,
      destinationToken: opts.dest.lifiToken,
      recipient: opts.recipient,
      privyDid: opts.privyDid,
    });
    const floor = BigInt(String(q.quote.minAmountOut ?? q.quote.amountOut ?? "0"));
    if (floor <= 0n) throw new Error("quote had no usable output");
    const target = BigInt(opts.atomicTarget);
    return (probe * target + floor - 1n) / floor;
  }
  const q = await getQuote({
    swapType: "EXACT_OUTPUT",
    chain: opts.chain,
    amount: opts.atomicTarget,
    destinationAsset: opts.dest.nearAsset,
    recipient: opts.recipient,
    privyDid: opts.privyDid,
  });
  const amountIn = q.quote.amountIn;
  if (!amountIn || !/^\d+$/.test(amountIn)) throw new Error("quote had no usable amountIn");
  return BigInt(amountIn);
}

/** Creates the swap (deposit address or route to sign), retrying once with more headroom on a 422. */
export async function createSwap(opts: {
  privyDid: string;
  chain: SwapChain;
  refundAddress: string;
  recipient: string;
  dest: SwapDestination;
  atomicTarget: string;
  quotedIn: bigint;
  idempotencyKey: string;
  expiresInSeconds: number;
  what?: string;
}): Promise<{ wallet: XrplWallet; swapAmount: string }> {
  const meta = SWAP_CHAIN_META[opts.chain];
  for (const [i, buffer] of BUFFERS.entries()) {
    const swapAmount = atomicToDecimalCeil(scaleUp(opts.quotedIn, buffer), meta.decimals);
    try {
      const wallet = await createWalletRequest({
        privyDid: opts.privyDid,
        // Distinct per attempt: a 422 writes nothing, but keep keys unambiguous.
        idempotencyKey: i === 0 ? opts.idempotencyKey : `${opts.idempotencyKey}:${i}`,
        chain: opts.chain,
        refundAddress: opts.refundAddress,
        swapAmount,
        swapRecipient: opts.recipient,
        ...(meta.kind === "route"
          ? { swapDestinationChain: opts.dest.lifiChain, swapDestinationToken: opts.dest.lifiToken }
          : { swapDestinationAsset: opts.dest.nearAsset }),
        swapMinAmountOut: opts.atomicTarget,
        swapExpiresInSeconds: opts.expiresInSeconds,
      });
      if (meta.kind === "route" && !wallet.payment?.transactionRequest) {
        throw new Error(`Couldn't prepare the ${meta.label} payment — please try again.`);
      }
      return { wallet, swapAmount };
    } catch (err) {
      if (errStatus(err) === 422 && i < BUFFERS.length - 1) continue;
      console.error(`[swap] ${opts.chain}: wallet request failed:`, err instanceof Error ? err.message : err);
      if (errStatus(err) === 422) throw new Error(`The ${meta.label} rate moved while pricing this — please try again in a moment.`);
      if (err instanceof Error && !errStatus(err) && err.message.startsWith("Couldn't prepare")) throw err;
      throw swapUserError(err, opts.chain, opts.what);
    }
  }
  throw swapUserError(null, opts.chain, opts.what);
}

/** bluvfi-xrpl swap status → what the UI and AI show. */
export type SwapProgress = "awaiting_payment" | "processing" | "completed" | "failed" | "expired";

export function swapProgress(status: XrplWallet["swapStatus"]): SwapProgress {
  switch (status) {
    case "COMPLETED": return "completed";
    case "REFUNDED":
    case "FAILED": return "failed";
    case "EXPIRED": return "expired";
    case "DEPOSIT_SUBMITTED":
    case "PROCESSING": return "processing";
    default: return "awaiting_payment";
  }
}
