/**
 * Top up the user's own Bluvfi wallet on Base from Arc, Tempo, Robinhood
 * Chain, Zcash or Hyperliquid — the way those chains pay Cryptorefills,
 * Backpack stocks and Doma Base listings. bluvfi-xrpl swaps the payment into
 * USDC (or ETH) delivered to the user's Bluvfi wallet on Base; the provider's
 * normal wallet checkout then runs exactly as it does today (x402 signature,
 * Backpack deposit, Seaport fill), so no provider gets a new crediting path.
 *
 * Safety: the recipient must be one of the user's own wallets, as Privy
 * reports them server-side (never trusted from the client). Each top-up gets a
 * payments row (type "bridge", referenceId = swap id) which is also the
 * ownership record the status and transaction routes check.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseUnits } from "viem";
import { getUserWalletAddresses } from "@/lib/auth";
import type { XrplWallet } from "@/lib/xrplBackend";
import { describeChainSwap, getOwnedChainSwap, recordChainSwap, refreshChainSwap, reportRouteTx } from "@/lib/chain-swaps";
import { MIN_DEPOSIT_SWAP_USD, SWAP_CHAIN_META, type SwapChain } from "@/lib/swap-chains";
import { BASE_ETH_DEST, BASE_USDC_DEST, createSwap, priceSwap, swapUserError, type SwapProgress } from "@/lib/swap-server";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

export type TopUpToken = "usdc" | "eth";
export type TopUpPurpose = "cryptorefills" | "stocks" | "doma" | "wallet";

const PURPOSE_LABEL: Record<TopUpPurpose, string> = {
  cryptorefills: "Cryptorefills",
  stocks: "Backpack stocks",
  doma: "Doma listing",
  wallet: "wallet",
};

export interface TopUpResult {
  walletRequestId: string;
  chain: SwapChain;
  /** What the user pays, as a decimal in `symbol`. */
  amount: string;
  symbol: string;
  depositAddress: string | null;
  depositMemo: string | null;
  refundAddress: string;
  expiresAt: string | null;
  payment: XrplWallet["payment"] | null;
  /** What lands in the Bluvfi wallet on Base. */
  receive: { token: TopUpToken; amount: string; recipient: string };
}

export async function startWalletTopUp(opts: {
  privyDid: string;
  chain: SwapChain;
  token: TopUpToken;
  /** Decimal amount of `token` that must arrive on Base. */
  amount: string;
  /** USD value of `amount` (equal to it for USDC). */
  amountUsd: number;
  /** The Bluvfi wallet to fund — checked against Privy. */
  recipient: string;
  /** Required for Zcash / Hyperliquid; defaults to the Bluvfi wallet elsewhere. */
  refundAddress?: string;
  purpose: TopUpPurpose;
  /** What it pays for, e.g. "Netflix US $25", "AAPL buy", "software.ai" — kept for tracing. */
  reference?: string;
}): Promise<TopUpResult> {
  const reference = opts.reference?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const meta = SWAP_CHAIN_META[opts.chain];
  if (!/^\d+(\.\d+)?$/.test(opts.amount) || !(Number(opts.amount) > 0)) throw new Error("Enter an amount above 0.");
  if (!(opts.amountUsd > 0) || opts.amountUsd > 10_000) throw new Error("Top-ups are limited to $10,000.");
  if (meta.kind === "deposit" && opts.amountUsd < MIN_DEPOSIT_SWAP_USD) {
    throw new Error(`Top-ups from ${meta.label} start at $${MIN_DEPOSIT_SWAP_USD.toFixed(2)}.`);
  }

  const { evm } = await getUserWalletAddresses(opts.privyDid);
  const recipient = opts.recipient.toLowerCase();
  if (!evm.includes(recipient)) throw new Error("That isn't one of your Bluvfi wallets.");

  const refundAddress = (opts.refundAddress?.trim() || (meta.needsRefundAddress ? "" : opts.recipient)).trim();
  if (!meta.refundPattern.test(refundAddress)) {
    throw new Error(`Enter ${meta.refundHint} so a failed payment can be refunded.`);
  }
  // Route chains are signed by the Bluvfi wallet, so the route is built for it.
  if (meta.kind === "route" && refundAddress.toLowerCase() !== recipient) {
    throw new Error(`${meta.label} payments are signed by your Bluvfi wallet.`);
  }

  const dest = opts.token === "eth" ? BASE_ETH_DEST : BASE_USDC_DEST;
  const atomicTarget = parseUnits(opts.amount, dest.decimals).toString();

  let quotedIn: bigint;
  try {
    quotedIn = await priceSwap({ chain: opts.chain, atomicTarget, targetUsd: opts.amountUsd, dest, recipient: opts.recipient, privyDid: opts.privyDid });
  } catch (err) {
    console.error(`[chain-topup] ${opts.chain}: quote failed:`, err instanceof Error ? err.message : err);
    throw swapUserError(err, opts.chain, "this top-up");
  }

  const { wallet, swapAmount } = await createSwap({
    privyDid: opts.privyDid,
    chain: opts.chain,
    refundAddress,
    recipient: opts.recipient,
    dest,
    atomicTarget,
    quotedIn,
    idempotencyKey: `topup:${randomUUID()}`,
    expiresInSeconds: 900,
    what: "this top-up",
  });

  const symbol = opts.token === "eth" ? "ETH" : "USDC";
  const payAmount = wallet.requiredActivationAmount ?? swapAmount;
  await recordChainSwap({
    userId: opts.privyDid,
    wallet,
    purpose: opts.purpose,
    reference,
    chain: opts.chain,
    refundAddress,
    payAmount,
    paySymbol: meta.symbol,
    recipient: opts.recipient,
    receiveAmount: opts.amount,
    receiveAsset: `${symbol} on Base`,
    amountUsd: opts.amountUsd,
  });
  await db.insert(payments).values({
    userId: opts.privyDid,
    type: "bridge",
    referenceId: wallet.id,
    description: `Top-up: ${opts.amount} ${symbol} on Base from ${meta.label} (${PURPOSE_LABEL[opts.purpose]}${reference ? `: ${reference}` : ""})`,
    amountUsdc: opts.amountUsd.toFixed(2),
    status: "pending",
    chain: opts.chain,
  });

  return {
    walletRequestId: wallet.id,
    chain: opts.chain,
    amount: payAmount,
    symbol: meta.symbol,
    depositAddress: meta.kind === "deposit" ? wallet.address : null,
    depositMemo: wallet.depositMemo ?? null,
    refundAddress,
    expiresAt: wallet.swapExpiresAt,
    payment: wallet.payment ?? null,
    receive: { token: opts.token, amount: opts.amount, recipient: opts.recipient },
  };
}

export async function getTopUpStatus(userId: string, walletRequestId: string): Promise<{ progress: SwapProgress; error: string | null; chain: string | null; summary: string }> {
  const row = await getOwnedChainSwap(userId, walletRequestId);
  if (!row) throw new Error("That top-up wasn't found, or doesn't belong to this account.");
  const fresh = await refreshChainSwap(row);
  return { progress: fresh.status as SwapProgress, error: fresh.error, chain: fresh.chain, summary: describeChainSwap(fresh).summary };
}

/** Route chains (Arc, Tempo): saves, then reports, the signed transaction's hash for this user's top-up. */
export async function reportTopUpTransaction(userId: string, walletRequestId: string, txHash: string): Promise<{ reported: boolean }> {
  return reportRouteTx(userId, walletRequestId, txHash);
}
