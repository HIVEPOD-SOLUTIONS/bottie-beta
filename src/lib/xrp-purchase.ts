/**
 * "Pay with XRP" purchase orchestration — shared by the AI tool
 * (buy_bitrefill_product in tools.ts) and the dashboard's XRP purchase route
 * (api/bitrefill/xrp-purchase), so the flow only exists in one place.
 *
 * The underlying Bitrefill invoice always settles in USDC — "paying with
 * XRP" means the user sends XRP to a bluvfi-xrpl swap wallet, which
 * forwards it through NEAR Intents into USDC and delivers it to the
 * invoice's own payment address. Bitrefill itself never sees XRP.
 *
 * NEAR Intents assetIds and unit conventions below are confirmed directly
 * against C:/Users/XPS/bluvfi-xrpl's source (src/lib/nearIntents.ts,
 * src/schemas/xrpl.schemas.ts) AND a live GET /v0/tokens call
 * (2026-08-31) - not guessed. Every chain except usdc_base returned a real,
 * successful quote through bluvfi-xrpl's own POST /api/xrpl/quote at that
 * time (both EXACT_INPUT and EXACT_OUTPUT). usdc_base has a confirmed,
 * reproducible NEAR Intents-side "Internal server error" specific to that
 * one destination asset - excluded from the default, kept available since
 * it's a real, valid option once NEAR Intents fixes it, not a permanent
 * design choice.
 *
 * NEAR Intents route availability has been observed to change over time
 * (a chain that fails today may work tomorrow, or vice versa) - the
 * exclusion above reflects what was reproducible as of this date, not a
 * permanent guarantee either way for any chain including the ones enabled.
 *
 *   - swapMinAmountOut / the quote `amount` field (EXACT_OUTPUT mode): a
 *     whole-number string in the destination asset's smallest unit.
 *     **USDC is 6 decimals on every chain here except BSC, which is 18** -
 *     confirmed against the live token catalog, not assumed uniform. See
 *     USDC_DECIMALS below - usdToAtomicUsdc takes decimals explicitly
 *     rather than hardcoding 6, specifically because of this exception.
 *   - swapAmountXrp: a decimal XRP string, e.g. "2.5" — NOT drops.
 *   - The quote's `amountIn`/`amountInFormatted` (populated for
 *     EXACT_OUTPUT) is bluvfi-xrpl's own documented "the estimated XRP
 *     required" — amountIn itself is in drops; amountInFormatted (if
 *     present) is already the decimal XRP string swapAmountXrp needs.
 */

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { mcpBuyProducts } from "@/lib/bitrefill-mcp";
import { getQuote, createWalletRequest, getWalletRequest, transferBetweenWallets } from "@/lib/xrplBackend";
import { db } from "@/lib/db";
import { bitrefillOrders, payments, xrplSidebarWallets } from "@/lib/db/schema";

export type UnderlyingMethod =
  | "usdc_base"
  | "usdc_solana"
  | "usdc_erc20"
  | "usdc_arbitrum"
  | "usdc_polygon"
  | "usdc_bsc";

// assetIds confirmed live against GET /v0/tokens (2026-08-31). The two
// assetId shapes (nep141:<chain>-0x....omft.near vs.
// nep245:v2_1.omni.hot.tg:<chainId>_<id>) are both real NEAR Intents
// conventions, not a typo - bluvfi-xrpl's own EVM-address validation
// (src/schemas/xrpl.schemas.ts) recognizes both.
const USDC_DESTINATION_ASSET: Record<UnderlyingMethod, string> = {
  usdc_base: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  usdc_solana: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  usdc_erc20: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  usdc_arbitrum: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  usdc_polygon: "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L",
  usdc_bsc: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r",
};

// USDC's decimal count is NOT uniform across chains - BSC's bridged
// representation is 18 decimals, every other chain here is 6. Confirmed
// against the live token catalog (each entry's own "decimals" field), not
// assumed. Getting this wrong for BSC specifically would compute an
// atomicTarget off by a factor of 10^12 - silently far too small, not an
// error that surfaces cleanly.
const USDC_DECIMALS: Record<UnderlyingMethod, number> = {
  usdc_base: 6,
  usdc_solana: 6,
  usdc_erc20: 6,
  usdc_arbitrum: 6,
  usdc_polygon: 6,
  usdc_bsc: 18,
};

/**
 * USD amount → whole-number string in the given asset's smallest unit.
 *
 * Deliberately NOT `Math.round(usd * 10 ** decimals)` - for BSC's 18
 * decimals, that multiplication silently loses precision (a JS number's
 * safe integer range is ~9×10^15; 10^18 alone already exceeds it, before
 * even multiplying by a real dollar amount). Instead: round to cents
 * first (safe - USD prices only ever carry 2 decimal places, nowhere near
 * float precision limits), then scale the *remaining* decimals with
 * BigInt exponentiation, which is exact regardless of magnitude.
 */
function usdToAtomicUsdc(usd: number, decimals: number): string {
  if (decimals < 2) {
    throw new Error(`usdToAtomicUsdc: unexpected decimals ${decimals} (expected USDC-like, >= 2)`);
  }
  const cents = Math.round(usd * 100);
  return (BigInt(cents) * 10n ** BigInt(decimals - 2)).toString();
}

// NEAR Intents enforces its own minimum bridge amount server-side — live-
// tested against bluvfi-xrpl's real /api/xrpl/quote (2026-09-01): a request
// under this rejects with a 400 whose message reads
// "Amount is too low for bridge, try at least <atomic units>" (that specific
// test's rejection worked out to ~$2.75). Set deliberately higher than that
// observed floor — $5 — as a safety margin, since NEAR Intents' real
// threshold has been observed to drift over time and a bare-minimum-priced
// item is exactly the case most likely to tip over it between this pre-
// filter and the swap actually executing. This is a *pre-filter* only —
// skips a wasted invoice+quote round trip for an obviously-too-cheap
// product. The authoritative check is isAmountTooLowError() below, matched
// against NEAR Intents' actual live response.
// Exported so callers (e.g. the AI tool's own description) can reference the
// live value directly instead of hardcoding a copy that could drift out of
// sync with this one.
export const MIN_XRP_BRIDGE_USD = 5;

/**
 * True when an error thrown by getQuote() is NEAR Intents' own "amount too
 * low to bridge" rejection, as opposed to some other quote failure (route
 * unavailable, NEAR Intents outage, etc.). Matched on the message text
 * bluvfi-xrpl proxies straight through from NEAR Intents' own 400 response
 * ("Amount is too low for bridge, try at least ...") — confirmed via a live
 * call, not guessed.
 */
function isAmountTooLowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /too low|amount is too low/i.test(message);
}

export interface XrpPurchaseResult {
  invoiceId: string;
  invoiceAccessToken?: string;
  /** XRPL address to send XRP to */
  paymentAddress: string;
  /** Minimum XRP the address needs to hold to be activated on-ledger */
  requiredActivationXrp: number;
  /** Exact amount to send, in drops (1 XRP = 1,000,000 drops) */
  swapAmountDrops: string | null;
  /** ISO deadline — swap must be *initiated* before this */
  swapExpiresAt: string | null;
  /** Underlying invoice price, in USD */
  priceUsd: number;
  xrplWalletRequestId: string;
  expirationMinutes?: number;
}

// Fallback priority order when the caller doesn't pin a specific chain —
// most-reliable-first, based on repeated live testing against bluvfi-xrpl's
// real /api/xrpl/quote throughout this integration's build (2026-08-31):
// Solana passed every single test run, no exceptions. Arbitrum/Polygon/
// Ethereum/BSC fluctuated — sometimes all passed, sometimes all failed
// together, suggesting their availability moves as a block, not
// independently. Base failed 100% of test runs, every time, including
// direct-to-NEAR-Intents calls that bypassed bluvfi-xrpl entirely — kept
// last rather than removed, since it's a real option again once NEAR
// Intents fixes it, not a permanently broken one.
//
// Optimism is NOT in this list — Bitrefill's own buy-products tool doesn't
// accept "usdc_optimism"/"usdt_optimism" as a payment_method at all (a live
// invoice-creation call against it returns a hard MCP validation error, not
// a graceful "unavailable"), confirmed 2026-09-01. It's excluded from
// UnderlyingMethod entirely for the same reason — no amount of NEAR Intents
// support on that asset would ever let a Bitrefill invoice settle there.
const FALLBACK_PRIORITY: UnderlyingMethod[] = [
  "usdc_solana",
  "usdc_arbitrum",
  "usdc_polygon",
  "usdc_erc20",
  "usdc_bsc",
  "usdc_base",
];

type AttemptResult =
  | {
      ok: true;
      invoice: Awaited<ReturnType<typeof mcpBuyProducts>>;
      underlyingMethod: UnderlyingMethod;
      priceUsdNum: number;
      destinationAsset: string;
      atomicTarget: string;
      swapAmountXrp: string;
    }
  // This candidate specifically isn't available (unsupported method,
  // transient error, no route) — the caller's fallback loop should move on
  // to the next chain.
  | { ok: false; reason: "chain_unavailable" }
  // The *price* is below NEAR Intents' bridge minimum — true for every
  // chain, not just this one, since it's a property of the product's USD
  // cost. The caller should stop the fallback loop entirely and tell the
  // user, rather than wasting five more invoice+quote round trips on a
  // failure mode retrying can't fix.
  | { ok: false; reason: "amount_too_low"; priceUsdNum: number };

/**
 * One chain's full pre-flight attempt: create a Bitrefill invoice for that
 * specific chain, then confirm a live quote actually works for it. Never
 * throws for an ordinary per-candidate failure (returns a discriminated
 * `{ok:false}` instead), so the caller's fallback loop can cleanly move to
 * the next candidate — the created invoice is simply abandoned; Bitrefill
 * invoices need no explicit cancellation, an unpaid one just expires on its
 * own ~15 minutes later, the same as any user who never completes checkout.
 */
async function attemptChain(
  underlyingMethod: UnderlyingMethod,
  opts: { productId: string; packageId: string; recipientEmail?: string; recipientName?: string; sendTo?: string; privyDid: string },
): Promise<AttemptResult> {
  // Invoice creation itself can fail per-candidate — not just "Bitrefill is
  // down" but also a payment_method Bitrefill's buy-products tool simply
  // doesn't recognize for this product (confirmed live: usdc_optimism threw
  // a raw MCP -32602 validation error that used to crash the entire
  // purchase instead of just skipping that one chain). Treat any failure
  // here the same as a failed quote below — abandon this candidate, let the
  // caller move on.
  // Same pattern as api/bitrefill/invoice/route.ts's own webhookUrl - only
  // sent to Bitrefill when we have a public HTTPS base URL, since a
  // localhost webhook can't be reached by Bitrefill's servers. Without this,
  // Bitrefill has no per-invoice way to tell bluvfi whether an XRP-paid
  // purchase actually got fulfilled - api/bitrefill/webhook/route.ts (which
  // reports CONFIRMED/FAILED back into bluvfi-xrpl) simply never fires for
  // this flow, and bluvfi-xrpl's own webhook only reports the money
  // movement (the swap completing), not whether Bitrefill delivered the
  // product on their end - that distinction is the whole reason the
  // service-confirmation step exists at all.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const webhookUrl = appUrl.startsWith("https://")
    ? `${appUrl}/api/bitrefill/webhook`
    : undefined;

  let invoice: Awaited<ReturnType<typeof mcpBuyProducts>>;
  try {
    invoice = await mcpBuyProducts({
      productId: opts.productId,
      packageId: opts.packageId,
      paymentMethod: underlyingMethod,
      recipientEmail: opts.recipientEmail,
      recipientName: opts.recipientName,
      refillInput: opts.sendTo,
      returnPaymentLink: false,
      webhookUrl,
    });
  } catch (err) {
    console.error(
      `[xrp-purchase] invoice creation failed for ${underlyingMethod}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "chain_unavailable" };
  }

  const invoiceAddress = invoice.payment_info?.address;
  const priceUsd = invoice.payment_info?.altcoinPrice ?? invoice.payment_info?.amount;
  if (!invoiceAddress || priceUsd == null) {
    // Same reasoning — malformed invoice response for this chain, not a
    // reason to abort the whole purchase.
    console.error(
      `[xrp-purchase] ${underlyingMethod}: invoice missing address/amount`,
      invoice.payment_info,
    );
    return { ok: false, reason: "chain_unavailable" };
  }
  const priceUsdNum = Number(priceUsd);

  // Fast pre-filter: skip the quote round trip entirely for an obviously-
  // too-cheap product — NEAR Intents will reject it anyway (confirmed live,
  // see MIN_XRP_BRIDGE_USD), and the price is the same regardless of which
  // chain we'd otherwise try next.
  if (priceUsdNum < MIN_XRP_BRIDGE_USD) {
    return { ok: false, reason: "amount_too_low", priceUsdNum };
  }

  const destinationAsset = USDC_DESTINATION_ASSET[underlyingMethod];
  const atomicTarget = usdToAtomicUsdc(priceUsdNum, USDC_DECIMALS[underlyingMethod]);

  try {
    const quote = await getQuote({
      swapType: "EXACT_OUTPUT",
      amount: atomicTarget,
      destinationAsset,
      recipient: invoiceAddress,
      privyDid: opts.privyDid,
    });
    const q = quote.quote;
    const swapAmountXrp = q.amountInFormatted
      ?? (q.amountIn ? String(Number(q.amountIn) / 1_000_000) : null);
    if (!swapAmountXrp) {
      // quote succeeded but returned no usable amount — treat as unavailable, try next chain
      console.error(`[xrp-purchase] ${underlyingMethod}: quote had no usable amountIn`, q);
      return { ok: false, reason: "chain_unavailable" };
    }

    return { ok: true, invoice, underlyingMethod, priceUsdNum, destinationAsset, atomicTarget, swapAmountXrp };
  } catch (err) {
    // NEAR Intents' own "too low to bridge" rejection — chain-independent,
    // the caller should stop the fallback loop, not try five more chains
    // for the same product at the same price.
    if (isAmountTooLowError(err)) {
      console.error(`[xrp-purchase] ${underlyingMethod}: NEAR Intents rejected as too low to bridge ($${priceUsdNum.toFixed(2)})`);
      return { ok: false, reason: "amount_too_low", priceUsdNum };
    }
    // Any other quote failure for this chain — abandon this invoice, let the caller try the next candidate.
    console.error(
      `[xrp-purchase] quote failed for ${underlyingMethod}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "chain_unavailable" };
  }
}

export async function initiateXrpPurchase(opts: {
  productId: string;
  packageId: string;
  privyDid: string;
  recipientEmail?: string;
  recipientName?: string;
  sendTo?: string;
  /**
   * Pin a specific chain instead of the automatic fallback below. Leave
   * unset for the normal (recommended) behavior.
   */
  underlyingMethod?: UnderlyingMethod;
}): Promise<XrpPurchaseResult> {
  // Explicit override: try exactly that one chain, no fallback — the caller
  // asked for it specifically, so a failure should surface directly rather
  // than silently substituting a different chain than what was requested.
  const candidates = opts.underlyingMethod ? [opts.underlyingMethod] : FALLBACK_PRIORITY;

  let result: (AttemptResult & { ok: true }) | null = null;

  for (const candidate of candidates) {
    const attempt = await attemptChain(candidate, opts);

    if (attempt.ok) { result = attempt; break; }

    // Price-too-cheap-for-XRP is a property of the product, not the chain —
    // no point burning invoice-creation calls trying more chains for
    // something that will fail identically on all of them. Stop and tell
    // the user immediately instead of exhausting the rest of the fallback
    // list first.
    if (attempt.reason === "amount_too_low") {
      // User-facing — deliberately says nothing about NEAR Intents, bridging,
      // or swapping (see the file header + bills-screen.tsx's XRP UI: the
      // User-facing — states the actual minimum so the user can act on it
      // (pick a bigger amount) instead of just being told "no" with nothing
      // to go on. Still deliberately says nothing about NEAR Intents,
      // bridging, or swapping — internal mechanism is never named to the
      // user, only "paying with XRP".
      throw new Error(
        `This item's price ($${attempt.priceUsdNum.toFixed(2)}) is too low to pay with XRP — the minimum is $${MIN_XRP_BRIDGE_USD.toFixed(2)}. Please choose a different payment method, or increase the amount to at least $${MIN_XRP_BRIDGE_USD.toFixed(2)}.`,
      );
    }
    // reason === "chain_unavailable" — fall through and try the next candidate.
  }

  if (!result) {
    throw new Error(
      candidates.length > 1
        ? "Couldn't complete this payment right now — please try again in a few minutes, or use a different payment method."
        : "Couldn't get a price for this payment right now — please try again in a few minutes.",
    );
  }

  const { invoice, underlyingMethod, priceUsdNum, destinationAsset, atomicTarget, swapAmountXrp } = result;
  const invoiceAddress = invoice.payment_info!.address!;
  if (underlyingMethod !== candidates[0]) {
    console.log(`[xrp-purchase] fell back to ${underlyingMethod} (${candidates[0]} unavailable)`);
  }

  // ── Step 3: swap wallet request — back-to-back with the winning candidate's
  // invoice+quote above, no other async work in between. swapExpiresInSeconds
  // counts from this call. idempotencyKey = invoice id, so a retried purchase
  // reuses the same swap wallet instead of creating a duplicate.
  const wallet = await createWalletRequest({
    privyDid: opts.privyDid,
    idempotencyKey: invoice.invoice_id,
    swapAmountXrp,
    swapRecipient: invoiceAddress,
    swapDestinationAsset: destinationAsset,
    swapMinAmountOut: atomicTarget,
    swapExpiresInSeconds: 450,
  });

  // ── Persist the mapping on the bitrefill_orders row ───────────────────────
  if (invoice.invoice_id) {
    const xrpAmount = wallet.swapAmountDrops
      ? String(Number(wallet.swapAmountDrops) / 1_000_000)
      : swapAmountXrp;

    db.insert(bitrefillOrders).values({
      userId: opts.privyDid,
      invoiceId: invoice.invoice_id,
      productId: opts.productId,
      productName: opts.productId,
      packageValue: opts.packageId,
      paymentMethod: "xrp",
      isAddressBased: true,
      paymentAddress: wallet.address,
      paymentAmount: xrpAmount,
      paymentCurrency: "XRP",
      amountUsdc: String(priceUsdNum),
      recipientEmail: opts.recipientEmail ?? null,
      chain: "xrpl",
      status: "pending",
      xrplWalletRequestId: wallet.id,
      xrplWalletAddress: wallet.address,
    }).onConflictDoUpdate({
      target: [bitrefillOrders.invoiceId],
      set: { status: "pending", updatedAt: new Date() },
    }).catch(() => {});

    db.insert(payments).values({
      userId: opts.privyDid,
      type: "bill",
      referenceId: invoice.invoice_id,
      description: `Bitrefill (XRP): ${opts.productId} ${opts.packageId}`,
      amountUsdc: String(priceUsdNum),
      status: "pending",
      chain: "xrpl",
    }).catch(() => {});
  }

  return {
    invoiceId: invoice.invoice_id,
    invoiceAccessToken: invoice.invoice_access_token,
    paymentAddress: wallet.address,
    requiredActivationXrp: wallet.requiredActivationXrp,
    swapAmountDrops: wallet.swapAmountDrops,
    swapExpiresAt: wallet.swapExpiresAt,
    priceUsd: priceUsdNum,
    xrplWalletRequestId: wallet.id,
    expirationMinutes: invoice.expiration_minutes,
  };
}

/**
 * Single, shared place to persist an XRP purchase's terminal failure
 * (FAILED / REFUNDED / EXPIRED swapStatus) to both bitrefill_orders AND
 * payments — the two tables History (payments-screen.tsx), the AI's
 * get_payment_history tool, and poll_bitrefill_order all read from.
 *
 * Before this existed, only one of the three places that can *detect* a
 * failed XRP swap actually wrote it back to `payments`:
 *   - tools.ts's poll_bitrefill_order (AI path) — updated both tables.
 *   - api/xrpl-webhook (async, out-of-band) — updated bitrefillOrders only.
 *   - bills-screen.tsx's live wallet-status poll (dashboard UI) — updated
 *     neither; it only set local React state to drive the error screen.
 * So a failure caught only by the webhook or the dashboard poll left the
 * `payments` row (and in the webhook's case, also nothing) stuck at
 * "pending" forever — History and the AI would report a dead purchase as
 * still in progress indefinitely. All three call sites now go through this
 * one function instead of duplicating (and drifting from) the same logic.
 *
 * Safe to call more than once for the same walletRequestId (idempotent) and
 * safe to call from a caller that only has the walletRequestId, not the
 * invoiceId — that lookup happens here via bitrefillOrders' own indexed
 * xrplWalletRequestId column.
 *
 * Takes the already-resolved "failed" | "expired" status rather than a raw
 * swapStatus/event string, since callers speak two different vocabularies
 * (bluvfi-xrpl's XrplSwapStatus enum vs. its webhook event names) — each
 * resolves its own to one of these two before calling, rather than this
 * function guessing which one it was handed.
 */
export async function markXrpPurchaseFailed(
  walletRequestId: string,
  failStatus: "failed" | "expired",
): Promise<void> {
  const [order] = await db
    .select()
    .from(bitrefillOrders)
    .where(eq(bitrefillOrders.xrplWalletRequestId, walletRequestId))
    .limit(1)
    .catch(() => [undefined]);
  if (!order) return; // no matching purchase — nothing to reconcile

  // Never clobber a purchase that already completed — SWAP_COMPLETED doesn't
  // mean the Bitrefill purchase itself is done (see xrpl-webhook's own
  // comment), but if service confirmation already landed "complete" here,
  // a stale/late failure signal must not overwrite that.
  if (order.status === "complete") return;

  await db.update(bitrefillOrders)
    .set({ status: failStatus, updatedAt: new Date() })
    .where(eq(bitrefillOrders.id, order.id))
    .catch(() => {});

  if (order.invoiceId) {
    await db.update(payments)
      .set({ status: "failed" })
      .where(eq(payments.referenceId, order.invoiceId))
      .catch(() => {});
  }
}

// ── Recovery — shared by the dashboard's live "Recover your XRP" button,
// the persistent recoverable-orders list (bills-screen.tsx's "My Bills"
// tab), and the AI's own recovery tools. Consolidated here for the same
// reason markXrpPurchaseFailed is: four independent call sites re-deriving
// "is this recoverable, and how much" would drift the moment any one of
// them changed. ──────────────────────────────────────────────────────────

/**
 * Returns the user's persistent XRPL sidebar wallet, creating it on first
 * call — extracted from api/xrpl/sidebar-wallet/route.ts so a caller that
 * isn't itself an HTTP route (the AI's recovery tool) can get the same
 * wallet without an internal fetch. createWalletRequest is idempotent
 * server-side (bluvfi-xrpl), so calling this repeatedly for the same user
 * is safe — it only actually creates a wallet once.
 */
export async function getOrCreateSidebarWallet(userId: string): Promise<{ id: string; address: string }> {
  const [existing] = await db
    .select()
    .from(xrplSidebarWallets)
    .where(eq(xrplSidebarWallets.userId, userId))
    .limit(1);
  if (existing) return { id: existing.walletRequestId, address: existing.address };

  const wallet = await createWalletRequest({ privyDid: userId, idempotencyKey: "primary-xrp-wallet" });

  await db.insert(xrplSidebarWallets)
    .values({ userId, walletRequestId: wallet.id, address: wallet.address })
    .onConflictDoUpdate({
      target: xrplSidebarWallets.userId,
      set: { walletRequestId: wallet.id, address: wallet.address, updatedAt: new Date() },
    });

  return { id: wallet.id, address: wallet.address };
}

/**
 * True when `walletRequestId` resolves to a wallet `userId` actually owns —
 * checked against both tables that can hold one (a sidebar wallet, or a
 * purchase's own swap wallet). Moved here from api/xrpl/transfer/route.ts so
 * recoverXrpOrder below can reuse the same check server-side, not just HTTP
 * callers of that route.
 *
 * bluvfi-xrpl's own transferBetweenWallets only checks that source and
 * destination belong to the *same* userId as *each other* — it has no way
 * to know who's actually calling, since it's reached through a shared
 * service API key, not per-user auth. This is the missing half.
 */
export async function walletRequestBelongsToUser(walletRequestId: string, userId: string): Promise<boolean> {
  const [sidebarMatch] = await db
    .select({ id: xrplSidebarWallets.id })
    .from(xrplSidebarWallets)
    .where(and(eq(xrplSidebarWallets.walletRequestId, walletRequestId), eq(xrplSidebarWallets.userId, userId)))
    .limit(1);
  if (sidebarMatch) return true;

  const [orderMatch] = await db
    .select({ id: bitrefillOrders.id })
    .from(bitrefillOrders)
    .where(and(eq(bitrefillOrders.xrplWalletRequestId, walletRequestId), eq(bitrefillOrders.userId, userId)))
    .limit(1);
  return !!orderMatch;
}

export interface RecoverableXrpOrder {
  invoiceId: string;
  walletRequestId: string;
  productName: string;
  recoverableXrp: number;
  failedAt: Date;
}

const FAILURE_SWAP_STATUSES = new Set(["FAILED", "REFUNDED", "EXPIRED"]);

/**
 * Lists this user's "pay with XRP" purchases that failed AFTER the deposit
 * wallet was already funded — real XRP sitting in a wallet this backend
 * controls, un-recovered. Shared by GET /api/xrpl/recoverable-orders (the
 * dashboard's persistent list) and the AI's list_recoverable_xrp tool.
 *
 * Deliberately includes "pending" orders, not just ones already marked
 * "failed"/"expired" — bitrefill_orders.status only ever gets flipped to a
 * failure state by one of three surfaces actually running (the optional
 * async webhook, a live dashboard poll, or the AI's poll_bitrefill_order).
 * If none of those ever ran (tab closed immediately, webhook unset), the
 * row sits at "pending" forever even though bluvfi-xrpl's own swapStatus
 * may already show it failed — so every candidate is re-checked live
 * against bluvfi-xrpl, and a still-"pending" row discovered to have failed
 * is reconciled here via markXrpPurchaseFailed before being returned.
 */
export async function listRecoverableXrpOrders(userId: string): Promise<RecoverableXrpOrder[]> {
  const candidates = await db
    .select()
    .from(bitrefillOrders)
    .where(
      and(
        eq(bitrefillOrders.userId, userId),
        isNotNull(bitrefillOrders.xrplWalletRequestId),
        inArray(bitrefillOrders.status, ["pending", "failed", "expired"]),
        isNull(bitrefillOrders.xrplRecoveredAt),
      ),
    )
    .orderBy(bitrefillOrders.updatedAt)
    .limit(20)
    .catch(() => []);

  if (candidates.length === 0) return [];

  const results = await Promise.all(
    candidates.map(async (order): Promise<RecoverableXrpOrder | null> => {
      try {
        const wallet = await getWalletRequest(order.xrplWalletRequestId!);
        if (!FAILURE_SWAP_STATUSES.has(wallet.swapStatus)) return null;

        if (order.status === "pending") {
          const failStatus = wallet.swapStatus === "EXPIRED" ? "expired" : "failed";
          await markXrpPurchaseFailed(order.xrplWalletRequestId!, failStatus).catch(() => {});
        }

        const recoverableXrp = wallet.swapAmountDrops ? Number(wallet.swapAmountDrops) / 1_000_000 : 0;
        if (!recoverableXrp || recoverableXrp <= 0) return null;

        return {
          invoiceId: order.invoiceId,
          walletRequestId: order.xrplWalletRequestId!,
          productName: order.productName ?? "Digital product",
          recoverableXrp,
          failedAt: order.updatedAt,
        };
      } catch {
        return null; // bluvfi-xrpl lookup failed for this one — skip, retry next fetch
      }
    }),
  );

  return results
    .filter((r): r is RecoverableXrpOrder => r !== null)
    .sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime());
}

/**
 * Performs the actual recovery: moves a failed/expired purchase's stuck XRP
 * to the user's own sidebar wallet, and marks the order recovered. Shared
 * by POST /api/xrpl/transfer's recovery-direction branch and the AI's
 * recover_xrp_order tool — the single place this action happens, so a
 * dashboard-initiated and an AI-initiated recovery can never disagree about
 * amount, ownership, or what "already recovered" means.
 *
 * Always recovers to the caller's OWN sidebar wallet (created if it doesn't
 * exist yet) — never a caller-supplied destination — and always uses the
 * amount bluvfi-xrpl reports live right now, never a caller-supplied one,
 * so a stale or tampered amount can't be forwarded through.
 *
 * Throws with a message safe to surface directly to the user/AI on any
 * failure (not owned, nothing recoverable, transfer itself failed).
 */
export async function recoverXrpOrder(
  userId: string,
  walletRequestId: string,
): Promise<{ recoveredXrp: number; productName: string }> {
  const [order] = await db
    .select()
    .from(bitrefillOrders)
    .where(and(eq(bitrefillOrders.xrplWalletRequestId, walletRequestId), eq(bitrefillOrders.userId, userId)))
    .limit(1);
  if (!order) throw new Error("That payment wasn't found, or doesn't belong to this account.");
  if (order.xrplRecoveredAt) throw new Error("This payment's funds were already recovered.");

  const wallet = await getWalletRequest(walletRequestId);
  if (!FAILURE_SWAP_STATUSES.has(wallet.swapStatus)) {
    throw new Error("This payment hasn't failed (or already completed) — there's nothing to recover yet.");
  }
  const recoverableXrp = wallet.swapAmountDrops ? Number(wallet.swapAmountDrops) / 1_000_000 : 0;
  if (!recoverableXrp || recoverableXrp <= 0) {
    throw new Error("There's no recoverable balance left on this payment.");
  }

  if (order.status === "pending") {
    const failStatus = wallet.swapStatus === "EXPIRED" ? "expired" : "failed";
    await markXrpPurchaseFailed(walletRequestId, failStatus).catch(() => {});
  }

  const sidebarWallet = await getOrCreateSidebarWallet(userId);
  await transferBetweenWallets(walletRequestId, sidebarWallet.id, String(recoverableXrp));

  await db.update(bitrefillOrders)
    .set({ xrplRecoveredAt: new Date() })
    .where(eq(bitrefillOrders.id, order.id))
    .catch(() => {});

  return { recoveredXrp: recoverableXrp, productName: order.productName ?? "Digital product" };
}
