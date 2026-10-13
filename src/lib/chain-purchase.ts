/**
 * Bitrefill purchases paid from a chain bluvfi-xrpl swaps FROM, other than
 * XRPL: Zcash (ZEC), Hyperliquid (USDC on HyperCore) and Arc (USDC).
 *
 * Like "pay with XRP" (xrp-purchase.ts) the Bitrefill invoice itself always
 * settles in USDC; bluvfi-xrpl converts what the user pays into exactly that
 * and delivers it to the invoice's payment address. Unlike XRP there is NO
 * wallet of ours in between (and so no sidebar wallet and nothing to
 * recover):
 *
 *   - zcash / hyperliquid: NEAR Intents hands out a deposit address. The user
 *     pays it from their OWN wallet/account; a failed or expired swap is
 *     refunded by NEAR Intents to the refund address the user gave.
 *   - arc: LI.FI has no deposit address. bluvfi-xrpl returns an approval +
 *     transaction that the user's Bluvfi (Privy) wallet signs on Arc; the
 *     resulting hash is reported back with reportChainPurchaseTransaction().
 *
 * Every row is stored with xrplWalletRequestId set, so the existing
 * wallet-status poll, xrpl-webhook failure handling and Bitrefill webhook →
 * service confirmation all work for these purchases unchanged.
 */

import { and, eq } from "drizzle-orm";
import { mcpBuyProducts } from "@/lib/bitrefill-mcp";
import { createWalletRequest, getQuote, reportRouteTransaction, type XrplWallet } from "@/lib/xrplBackend";
import {
  FALLBACK_PRIORITY,
  MIN_XRP_BRIDGE_USD,
  USDC_DECIMALS,
  USDC_DESTINATION_ASSET,
  isAmountTooLowError,
  usdToAtomicUsdc,
  type UnderlyingMethod,
} from "@/lib/xrp-purchase";
import { db } from "@/lib/db";
import { bitrefillOrders, payments } from "@/lib/db/schema";

export type PurchaseChain = "zcash" | "hyperliquid" | "arc";
export const PURCHASE_CHAINS: readonly PurchaseChain[] = ["zcash", "hyperliquid", "arc"];

export function isPurchaseChain(v: unknown): v is PurchaseChain {
  return typeof v === "string" && (PURCHASE_CHAINS as readonly string[]).includes(v);
}

interface ChainMeta {
  label: string;
  symbol: string;
  /** Smallest-unit decimals of what the user pays, as bluvfi-xrpl counts them. */
  decimals: number;
  /** How the user pays: a deposit address (NEAR Intents) or a signed route (LI.FI). */
  kind: "deposit" | "route";
  refundPattern: RegExp;
  refundHint: string;
}

export const CHAIN_META: Record<PurchaseChain, ChainMeta> = {
  zcash: {
    label: "Zcash",
    symbol: "ZEC",
    decimals: 8,
    kind: "deposit",
    // Transparent addresses only - NEAR Intents refunds to t-addresses (t1 P2PKH / t3 P2SH).
    refundPattern: /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/,
    refundHint: "a transparent Zcash address (starts with t1 or t3)",
  },
  hyperliquid: {
    label: "Hyperliquid",
    symbol: "USDC",
    decimals: 8,
    kind: "deposit",
    refundPattern: /^0x[0-9a-fA-F]{40}$/,
    refundHint: "your Hyperliquid account address (0x…)",
  },
  arc: {
    label: "Arc",
    symbol: "USDC",
    decimals: 6,
    kind: "route",
    refundPattern: /^0x[0-9a-fA-F]{40}$/,
    refundHint: "your Bluvfi wallet address (0x…)",
  },
};

/** Arc routes land as USDC on Base — LI.FI quotes Base reliably, and Bitrefill accepts usdc_base. */
const ARC_UNDERLYING: UnderlyingMethod = "usdc_base";
const ARC_DESTINATION_CHAIN = "8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/**
 * Headroom on top of the quoted input so the swap's GUARANTEED floor still
 * covers the invoice once it is re-quoted at creation. bluvfi-xrpl refuses
 * (422) rather than under-pay, so a too-small buffer only costs a retry.
 */
const BUFFERS = [1.01, 1.025];

/** Atomic → decimal string, rounded UP so the user never sends less than needed. */
function atomicToDecimalCeil(atomic: bigint, decimals: number): string {
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

function errStatus(err: unknown): number | undefined {
  return (err as { status?: number } | null)?.status;
}

/** Messages that are safe to show the user (and the AI) as-is. */
function userFacingError(err: unknown, chain: PurchaseChain): Error {
  const status = errStatus(err);
  const raw = err instanceof Error ? err.message : String(err);
  const { label } = CHAIN_META[chain];
  if (status === 400 && /not available|not enabled|disabled/i.test(raw)) {
    return new Error(`Paying with ${label} isn't available right now. Please choose a different payment method.`);
  }
  if (status === 400 && /refund/i.test(raw)) {
    return new Error(`That refund address doesn't look right — it must be ${CHAIN_META[chain].refundHint}.`);
  }
  return new Error(`Couldn't get a price for paying with ${label} right now — please try again in a few minutes, or use a different payment method.`);
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
  /** zcash / hyperliquid: where to send it. Null for arc. */
  depositAddress: string | null;
  /** zcash / hyperliquid: memo the payment MUST include, if any. */
  depositMemo: string | null;
  refundAddress: string;
  /** ISO deadline — the payment must be sent before this. */
  expiresAt: string | null;
  /** arc only: approval + transaction for the user's Bluvfi wallet to sign on Arc. */
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
  /** zcash/hyperliquid: the user's own address there. arc: the Bluvfi wallet that will sign. */
  refundAddress: string;
}): Promise<ChainPurchaseResult> {
  const meta = CHAIN_META[opts.chain];
  const refundAddress = opts.refundAddress.trim();
  if (!meta.refundPattern.test(refundAddress)) {
    throw new Error(`That refund address doesn't look right — it must be ${meta.refundHint}.`);
  }

  // ── 1. Invoice + live price ──────────────────────────────────────────────
  // NEAR Intents chains try the same USDC destinations as XRP, most reliable
  // first; Arc always lands on Base through LI.FI.
  const candidates: UnderlyingMethod[] = meta.kind === "route" ? [ARC_UNDERLYING] : FALLBACK_PRIORITY;
  let picked: {
    invoice: Awaited<ReturnType<typeof mcpBuyProducts>>;
    invoiceAddress: string;
    priceUsd: number;
    method: UnderlyingMethod;
    atomicTarget: string;
    /** Atomic origin amount the quote says covers the target, before buffering. */
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
    if (meta.kind === "deposit" && inv.priceUsd < MIN_XRP_BRIDGE_USD) {
      throw new Error(
        `This item's price ($${inv.priceUsd.toFixed(2)}) is too low to pay with ${meta.label} — the minimum is $${MIN_XRP_BRIDGE_USD.toFixed(2)}. Please choose a different payment method, or a larger amount.`,
      );
    }
    const atomicTarget = usdToAtomicUsdc(inv.priceUsd, USDC_DECIMALS[method]);

    try {
      let quotedIn: bigint;
      if (meta.kind === "route") {
        // LI.FI prices EXACT_INPUT only: ask what the invoice amount itself
        // buys, then scale the input by how much the route keeps.
        const q = await getQuote({
          swapType: "EXACT_INPUT",
          chain: opts.chain,
          amount: atomicTarget, // USDC → USDC: same 6 decimals on both sides
          destinationChain: ARC_DESTINATION_CHAIN,
          destinationToken: BASE_USDC,
          recipient: inv.address,
          privyDid: opts.privyDid,
        });
        const floor = BigInt(String(q.quote.minAmountOut ?? q.quote.amountOut ?? "0"));
        if (floor <= 0n) throw new Error("quote had no usable output");
        const target = BigInt(atomicTarget);
        quotedIn = (target * target + floor - 1n) / floor;
      } else {
        const q = await getQuote({
          swapType: "EXACT_OUTPUT",
          chain: opts.chain,
          amount: atomicTarget,
          destinationAsset: USDC_DESTINATION_ASSET[method],
          recipient: inv.address,
          privyDid: opts.privyDid,
        });
        const amountIn = q.quote.amountIn;
        if (!amountIn || !/^\d+$/.test(amountIn)) throw new Error("quote had no usable amountIn");
        quotedIn = BigInt(amountIn);
      }
      picked = { invoice: inv.invoice, invoiceAddress: inv.address, priceUsd: inv.priceUsd, method, atomicTarget, quotedIn };
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
      if (errStatus(err) === 400 && /not available|not enabled|disabled/i.test(String((err as Error).message))) break;
    }
  }

  if (!picked) throw userFacingError(lastErr, opts.chain);
  const { invoice, invoiceAddress, priceUsd, method, atomicTarget, quotedIn } = picked;

  // ── 2. Swap request (deposit address / route to sign) ────────────────────
  // Retried once with more headroom if the service's guarantee check (422)
  // says the fresh quote's floor falls short of the invoice.
  let wallet: XrplWallet | null = null;
  let swapAmount = "";
  for (const [i, buffer] of BUFFERS.entries()) {
    swapAmount = atomicToDecimalCeil(scaleUp(quotedIn, buffer), meta.decimals);
    try {
      wallet = await createWalletRequest({
        privyDid: opts.privyDid,
        // Distinct per attempt: a 422 writes nothing, but keep keys unambiguous.
        idempotencyKey: i === 0 ? invoice.invoice_id : `${invoice.invoice_id}:${i}`,
        chain: opts.chain,
        refundAddress,
        swapAmount,
        swapRecipient: invoiceAddress,
        ...(meta.kind === "route"
          ? { swapDestinationChain: ARC_DESTINATION_CHAIN, swapDestinationToken: BASE_USDC }
          : { swapDestinationAsset: USDC_DESTINATION_ASSET[method] }),
        swapMinAmountOut: atomicTarget,
        swapExpiresInSeconds: payWindowSeconds(invoice.expiration_minutes),
      });
      break;
    } catch (err) {
      if (errStatus(err) === 422 && i < BUFFERS.length - 1) continue;
      console.error(`[chain-purchase] ${opts.chain}: wallet request failed:`, err instanceof Error ? err.message : err);
      if (errStatus(err) === 422) {
        throw new Error(`The ${meta.label} rate moved while pricing this — please try again in a moment.`);
      }
      throw userFacingError(err, opts.chain);
    }
  }
  if (!wallet) throw userFacingError(null, opts.chain);

  if (meta.kind === "route" && !wallet.payment?.transactionRequest) {
    throw new Error(`Couldn't prepare the ${meta.label} payment — please try again.`);
  }

  const amount = wallet.requiredActivationAmount ?? swapAmount;
  const depositAddress = meta.kind === "deposit" ? wallet.address : null;

  // ── 3. Persist (same tables the XRP flow and History read) ───────────────
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
 * Arc only: hand bluvfi-xrpl the hash the user's wallet produced, after
 * checking the purchase belongs to this user. Safe to repeat with the same hash.
 */
export async function reportChainPurchaseTransaction(userId: string, walletRequestId: string, txHash: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Invalid transaction hash.");
  const [order] = await db
    .select({ id: bitrefillOrders.id, chain: bitrefillOrders.chain, invoiceId: bitrefillOrders.invoiceId })
    .from(bitrefillOrders)
    .where(and(eq(bitrefillOrders.xrplWalletRequestId, walletRequestId), eq(bitrefillOrders.userId, userId)))
    .limit(1);
  if (!order) throw new Error("That payment wasn't found, or doesn't belong to this account.");
  if (order.chain !== "arc") throw new Error("Only Arc payments report a transaction.");
  await reportRouteTransaction(walletRequestId, txHash);
  await db.update(payments)
    .set({ txHash })
    .where(and(eq(payments.referenceId, order.invoiceId), eq(payments.userId, userId)))
    .catch(() => {});
}
