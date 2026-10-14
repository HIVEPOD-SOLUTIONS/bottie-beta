/**
 * Bitrefill purchases paid from a chain bluvfi-xrpl swaps FROM, other than
 * XRPL: Zcash (ZEC), Hyperliquid (USDC on HyperCore), Robinhood Chain (ETH)
 * Arc (USDC) and Tempo (USDC.e).
 *
 * Like "pay with XRP" (xrp-purchase.ts) the Bitrefill invoice itself always
 * settles in USDC; bluvfi-xrpl converts what the user pays into exactly that
 * and delivers it to the invoice's payment address. Unlike XRP there is NO
 * wallet of ours in between (and so no sidebar wallet and nothing to
 * recover):
 *
 *   - zcash / hyperliquid / robinhood: NEAR Intents hands out a deposit
 *     address. The user pays it from their own wallet/account (Robinhood Chain
 *     ETH can also be sent from the Bluvfi wallet); a failed or expired swap is
 *     refunded by NEAR Intents to the refund address.
 *   - arc / tempo: LI.FI has no deposit address. bluvfi-xrpl returns an approval +
 *     transaction that the user's Bluvfi (Privy) wallet signs on Arc; the
 *     resulting hash is reported back with reportChainPurchaseTransaction().
 *
 * Pricing and swap creation are shared with wallet top-ups (swap-server.ts).
 * Every row is stored with xrplWalletRequestId set, so the existing
 * wallet-status poll, xrpl-webhook failure handling and Bitrefill webhook →
 * service confirmation all work for these purchases unchanged.
 */

import { and, eq } from "drizzle-orm";
import { mcpBuyProducts } from "@/lib/bitrefill-mcp";
import type { XrplWallet } from "@/lib/xrplBackend";
import { recordChainSwap, reportRouteTx } from "@/lib/chain-swaps";
import {
  FALLBACK_PRIORITY,
  USDC_DECIMALS,
  USDC_DESTINATION_ASSET,
  isAmountTooLowError,
  usdToAtomicUsdc,
  type UnderlyingMethod,
} from "@/lib/xrp-purchase";
import { BITREFILL_SWAP_CHAINS, MIN_DEPOSIT_SWAP_USD, SWAP_CHAIN_META, type SwapChainMeta } from "@/lib/swap-chains";
import { BASE_USDC_DEST, createSwap, isChainDisabledError, priceSwap, swapUserError, type SwapDestination } from "@/lib/swap-server";
import { db } from "@/lib/db";
import { bitrefillOrders, payments } from "@/lib/db/schema";

export type PurchaseChain = "zcash" | "hyperliquid" | "arc" | "robinhood" | "tempo";
export const PURCHASE_CHAINS = BITREFILL_SWAP_CHAINS as readonly PurchaseChain[];

export function isPurchaseChain(v: unknown): v is PurchaseChain {
  return typeof v === "string" && (PURCHASE_CHAINS as readonly string[]).includes(v);
}

export const CHAIN_META: Record<PurchaseChain, SwapChainMeta> = SWAP_CHAIN_META;

/** Route chains (Arc, Tempo) land as USDC on Base — LI.FI quotes Base reliably, and Bitrefill accepts usdc_base. */
const ROUTE_UNDERLYING: UnderlyingMethod = "usdc_base";

function destinationFor(method: UnderlyingMethod): SwapDestination {
  return { ...BASE_USDC_DEST, nearAsset: USDC_DESTINATION_ASSET[method], decimals: USDC_DECIMALS[method] };
}

export interface ChainPurchaseResult {
  chain: PurchaseChain;
  invoiceId: string;
  invoiceAccessToken?: string;
  expirationMinutes?: number;
  /** Underlying invoice price, in USD */
  priceUsd: number;
  walletRequestId: string;
  /** What the user pays, as a decimal in `symbol`. */
  amount: string;
  symbol: string;
  /** Deposit chains: where to send it. Null for route chains (Arc). */
  depositAddress: string | null;
  /** Deposit chains: memo the payment MUST include, if any. */
  depositMemo: string | null;
  refundAddress: string;
  /** ISO deadline — the payment must be sent before this. */
  expiresAt: string | null;
  /** Route chains: approval + transaction for the user's Bluvfi wallet to sign. */
  payment: XrplWallet["payment"] | null;
}

interface InvoiceOpts {
  productId: string;
  packageId: string;
  recipientEmail?: string;
  recipientName?: string;
  sendTo?: string;
}

async function createInvoice(method: UnderlyingMethod, opts: InvoiceOpts) {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const webhookUrl = appUrl.startsWith("https://") ? `${appUrl}/api/bitrefill/webhook` : undefined;
  const invoice = await mcpBuyProducts({
    productId: opts.productId,
    packageId: opts.packageId,
    paymentMethod: method,
    recipientEmail: opts.recipientEmail,
    recipientName: opts.recipientName,
    refillInput: opts.sendTo,
    returnPaymentLink: false,
    webhookUrl,
  });
  const address = invoice.payment_info?.address;
  const price = invoice.payment_info?.altcoinPrice ?? invoice.payment_info?.amount;
  if (!address || price == null) throw new Error(`invoice for ${method} is missing address/amount`);
  return { invoice, address, priceUsd: Number(price) };
}

/** Seconds the user gets to pay: inside the invoice's own window, never under 5 minutes. */
function payWindowSeconds(expirationMinutes?: number): number {
  const invoiceSeconds = (expirationMinutes ?? 15) * 60;
  return Math.max(300, Math.min(900, invoiceSeconds - 180));
}

export async function initiateChainPurchase(opts: InvoiceOpts & {
  privyDid: string;
  chain: PurchaseChain;
  /** zcash/hyperliquid: the user's own address there. arc/robinhood: the Bluvfi wallet (or, robinhood, any 0x of theirs). */
  refundAddress: string;
}): Promise<ChainPurchaseResult> {
  const meta = CHAIN_META[opts.chain];
  const refundAddress = opts.refundAddress.trim();
  if (!meta.refundPattern.test(refundAddress)) {
    throw new Error(`That refund address doesn't look right — it must be ${meta.refundHint}.`);
  }

  // ── 1. Invoice + live price ──────────────────────────────────────────────
  // NEAR Intents chains try the same USDC destinations as XRP, most reliable
  // first; route chains always land on Base through LI.FI.
  const candidates: UnderlyingMethod[] = meta.kind === "route" ? [ROUTE_UNDERLYING] : FALLBACK_PRIORITY;
  let picked: {
    invoice: Awaited<ReturnType<typeof mcpBuyProducts>>;
    invoiceAddress: string;
    priceUsd: number;
    dest: SwapDestination;
    atomicTarget: string;
    /** Atomic origin amount the quote says covers the target, before headroom. */
    quotedIn: bigint;
  } | null = null;
  let lastErr: unknown = null;

  for (const method of candidates) {
    let inv;
    try {
      inv = await createInvoice(method, opts);
    } catch (err) {
      console.error(`[chain-purchase] ${opts.chain}: invoice failed for ${method}:`, err instanceof Error ? err.message : err);
      lastErr = err;
      continue;
    }
    if (meta.kind === "deposit" && inv.priceUsd < MIN_DEPOSIT_SWAP_USD) {
      throw new Error(
        `This item's price ($${inv.priceUsd.toFixed(2)}) is too low to pay with ${meta.label} — the minimum is $${MIN_DEPOSIT_SWAP_USD.toFixed(2)}. Please choose a different payment method, or a larger amount.`,
      );
    }
    const dest = destinationFor(method);
    const atomicTarget = usdToAtomicUsdc(inv.priceUsd, dest.decimals);

    try {
      const quotedIn = await priceSwap({
        chain: opts.chain,
        atomicTarget,
        targetUsd: inv.priceUsd,
        dest,
        recipient: inv.address,
        privyDid: opts.privyDid,
      });
      picked = { invoice: inv.invoice, invoiceAddress: inv.address, priceUsd: inv.priceUsd, dest, atomicTarget, quotedIn };
      break;
    } catch (err) {
      if (isAmountTooLowError(err)) {
        throw new Error(
          `This item's price ($${inv.priceUsd.toFixed(2)}) is too low to pay with ${meta.label}. Please choose a different payment method, or a larger amount.`,
        );
      }
      console.error(`[chain-purchase] ${opts.chain}: quote failed for ${method}:`, err instanceof Error ? err.message : err);
      lastErr = err;
      // Chain switched off on the service: no point trying other destinations.
      if (isChainDisabledError(err)) break;
    }
  }

  if (!picked) throw swapUserError(lastErr, opts.chain);
  const { invoice, invoiceAddress, priceUsd, dest, atomicTarget, quotedIn } = picked;

  // ── 2. Swap request (deposit address / route to sign) ────────────────────
  const { wallet, swapAmount } = await createSwap({
    privyDid: opts.privyDid,
    chain: opts.chain,
    refundAddress,
    recipient: invoiceAddress,
    dest,
    atomicTarget,
    quotedIn,
    idempotencyKey: invoice.invoice_id,
    expiresInSeconds: payWindowSeconds(invoice.expiration_minutes),
  });

  const amount = wallet.requiredActivationAmount ?? swapAmount;
  const depositAddress = meta.kind === "deposit" ? wallet.address : null;

  // ── 3. Persist (same tables the XRP flow and History read, plus the swap ledger) ──
  await recordChainSwap({
    userId: opts.privyDid,
    wallet,
    purpose: "bitrefill",
    reference: invoice.invoice_id,
    chain: opts.chain,
    refundAddress,
    payAmount: amount,
    paySymbol: meta.symbol,
    recipient: invoiceAddress,
    receiveAmount: String(priceUsd),
    receiveAsset: "USDC (Bitrefill invoice)",
    amountUsd: priceUsd,
  }).catch((e: unknown) => console.error("[chain-purchase] swap ledger insert failed", e));

  await db.insert(bitrefillOrders).values({
    userId: opts.privyDid,
    invoiceId: invoice.invoice_id,
    productId: opts.productId,
    productName: opts.productId,
    packageValue: opts.packageId,
    paymentMethod: opts.chain,
    isAddressBased: meta.kind === "deposit",
    paymentAddress: depositAddress,
    paymentAmount: amount,
    paymentCurrency: meta.symbol,
    amountUsdc: String(priceUsd),
    recipientEmail: opts.recipientEmail ?? null,
    chain: opts.chain,
    status: "pending",
    xrplWalletRequestId: wallet.id,
  }).onConflictDoUpdate({
    target: [bitrefillOrders.invoiceId],
    set: { status: "pending", updatedAt: new Date() },
  }).catch((e: unknown) => console.error("[chain-purchase] order insert failed", e));

  await db.insert(payments).values({
    userId: opts.privyDid,
    type: "bill",
    referenceId: invoice.invoice_id,
    description: `Bitrefill (${meta.label} ${meta.symbol}): ${opts.productId} ${opts.packageId}`,
    amountUsdc: String(priceUsd),
    status: "pending",
    chain: opts.chain,
  }).catch(() => {});

  return {
    chain: opts.chain,
    invoiceId: invoice.invoice_id,
    invoiceAccessToken: invoice.invoice_access_token,
    expirationMinutes: invoice.expiration_minutes,
    priceUsd,
    walletRequestId: wallet.id,
    amount,
    symbol: meta.symbol,
    depositAddress,
    depositMemo: wallet.depositMemo ?? null,
    refundAddress,
    expiresAt: wallet.swapExpiresAt,
    payment: wallet.payment ?? null,
  };
}

/**
 * Route chains only (Arc): hand bluvfi-xrpl the hash the user's wallet
 * produced, after checking the purchase belongs to this user. Safe to repeat
 * with the same hash.
 */
export async function reportChainPurchaseTransaction(userId: string, walletRequestId: string, txHash: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Invalid transaction hash.");
  const [order] = await db
    .select({ id: bitrefillOrders.id, chain: bitrefillOrders.chain, invoiceId: bitrefillOrders.invoiceId })
    .from(bitrefillOrders)
    .where(and(eq(bitrefillOrders.xrplWalletRequestId, walletRequestId), eq(bitrefillOrders.userId, userId)))
    .limit(1);
  if (!order) throw new Error("That payment wasn't found, or doesn't belong to this account.");
  if (!isPurchaseChain(order.chain) || CHAIN_META[order.chain].kind !== "route") {
    throw new Error("Only signed-route payments (Arc) report a transaction.");
  }
  // Saved to the swap ledger first; a failed report is retried on the next refresh.
  await reportRouteTx(userId, walletRequestId, txHash);
  await db.update(payments)
    .set({ txHash })
    .where(and(eq(payments.referenceId, order.invoiceId), eq(payments.userId, userId)))
    .catch(() => {});
}
