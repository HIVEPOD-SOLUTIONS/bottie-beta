import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { markXrpPurchaseFailed } from "@/lib/xrp-purchase";

/**
 * POST /api/xrpl-webhook
 *
 * Receives activity events from bluvfi-xrpl — payload shape and signature
 * scheme confirmed directly against C:/Users/XPS/bluvfi-xrpl's
 * API_DOCUMENTATION.md ("Webhooks" section) and live-tested signature format:
 *
 *   { event, activityId, walletRequestId, userId,
 *     activity: { id, type, status, txHash, amountDrops, sourceTagSeen, metadata, errorMessage, createdAt },
 *     wallet: { ...full wallet summary, same shape as GET /wallet-requests/:id... },
 *     deliveredAt }
 *
 * Fires for every activity row created — WALLET_GENERATED,
 * ACTIVATION_DEPOSIT_DETECTED, WALLET_READY, DEPOSIT_RECEIVED, ERROR, and
 * (per the full activity-type table) also SWAP_COMPLETED, SWAP_REFUNDED,
 * SWAP_EXPIRED, SERVICE_PAYMENT_CONFIRMED/FAILED, INTERNAL_TRANSFER_SENT,
 * RESERVE_RECOVERED.
 *
 * Important: SWAP_COMPLETED here means the user's XRP successfully swapped
 * into USDC and was forwarded to the Bitrefill invoice address — it does
 * NOT mean the purchase itself is done. Bitrefill still needs to detect and
 * confirm the USDC arrived, reported separately via its own webhook
 * (api/bitrefill/webhook) calling reportServiceConfirmation. So this route
 * deliberately does NOT flip a row to "complete" on SWAP_COMPLETED — only
 * the genuine failure states (SWAP_REFUNDED/SWAP_EXPIRED/ERROR) get written
 * here, since those mean Bitrefill will never receive payment.
 *
 * Signature: `x-xrpl-webhook-signature: t=<unix_ts>,v1=<hex_hmac_sha256>`,
 * HMAC-SHA256 over `${t}.${rawBody}` (raw bytes, not re-serialized JSON —
 * verified against BLUVFI_XRPL_WEBHOOK_SECRET). ±5 min tolerance vs. replay.
 *
 * Dedup: bluvfi-xrpl explicitly documents that a delivery can be retried
 * even after a successful 2xx (e.g. the response itself was lost) and says
 * to dedupe on `activityId`. Not implemented as a separate seen-ids table
 * here — deliberately: every write this route makes (via
 * markXrpPurchaseFailed, setting bitrefill_orders.status AND payments.status
 * to "failed"/"expired" for a given xrplWalletRequestId) is naturally
 * idempotent, so a redelivered event is a harmless no-op rather than a
 * correctness bug. Revisit if this route ever does something non-idempotent
 * (e.g. sending a notification).
 *
 * This is one of three surfaces that can detect an XRP purchase failing —
 * see markXrpPurchaseFailed's own doc comment (src/lib/xrp-purchase.ts) for
 * why all three now share it instead of each writing the DB independently.
 */

const TOLERANCE_SECONDS = 5 * 60;

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k?.trim(), v?.trim()];
    }),
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;

  const tsNum = Number(t);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > TOLERANCE_SECONDS) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
  } catch {
    return false;
  }
}

// Genuine failure states — the swap won't complete, so the underlying
// Bitrefill invoice will never receive its USDC. SWAP_COMPLETED is
// deliberately absent — see file header comment.
const FAILURE_STATUS_MAP: Record<string, "failed" | "expired"> = {
  SWAP_REFUNDED: "failed",
  SWAP_EXPIRED: "expired",
  ERROR: "failed",
};

interface XrplWebhookPayload {
  event: string;
  activityId: string;
  walletRequestId: string;
  userId: string;
  activity?: { type?: string; status?: string; errorMessage?: string | null };
  wallet?: Record<string, unknown>;
  deliveredAt?: string;
}

export async function POST(req: NextRequest) {
  const secret = process.env.BLUVFI_XRPL_WEBHOOK_SECRET;
  const rawBody = await req.text();

  if (secret) {
    const sig = req.headers.get("x-xrpl-webhook-signature");
    if (!verifySignature(rawBody, sig, secret)) {
      console.warn("[xrpl-webhook] signature verification failed — rejecting");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    console.warn("[xrpl-webhook] BLUVFI_XRPL_WEBHOOK_SECRET not set — accepting unverified payload");
  }

  let payload: XrplWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { event, activityId, walletRequestId } = payload;
  if (!walletRequestId || !event) {
    console.error("[xrpl-webhook] missing event/walletRequestId in payload", payload);
    return NextResponse.json({ ok: true }); // ack anyway — malformed body, don't retry
  }

  // Include the activity's own errorMessage for ERROR/failure events — without
  // this, an ERROR event only logs its id, requiring a manual bluvfi-xrpl
  // API call just to find out what actually failed (exactly what happened
  // diagnosing a real swap failure — the log line alone wasn't enough).
  const errorDetail = payload.activity?.errorMessage;
  console.log(
    `[xrpl-webhook] walletRequestId=${walletRequestId} event=${event} activityId=${activityId}` +
    (errorDetail ? ` errorMessage=${JSON.stringify(errorDetail)}` : ""),
  );

  const dbStatus = FAILURE_STATUS_MAP[event];
  if (dbStatus) {
    // Shared with the dashboard's live wallet-status poll and the AI's
    // poll_bitrefill_order — writes both bitrefill_orders AND payments, so
    // History and the AI reflect this failure even if this webhook is the
    // only thing that ever detects it (e.g. the user already closed the app).
    markXrpPurchaseFailed(walletRequestId, dbStatus)
      .catch((e: unknown) => console.error("[xrpl-webhook] markXrpPurchaseFailed error", e));
  }
  // SWAP_COMPLETED and every other event: intentionally no DB write here —
  // see file header. The next poll of the underlying Bitrefill invoice
  // (pollInvoice client-side, or poll_bitrefill_order for the AI path) picks
  // up the eventual "complete" status once Bitrefill's own webhook fires and
  // calls reportServiceConfirmation.

  return NextResponse.json({ ok: true });
}
