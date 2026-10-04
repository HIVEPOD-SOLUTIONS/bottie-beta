import { getProvider } from "@/lib/banking/registry";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * POST /api/banking/webhook/[provider]
 *
 * Receives signed webhook events from a banking provider (e.g. Credible).
 * Verifies the signature, then persists status changes to the payments table
 * using referenceId = order_id / collection_id / merchant_payout_id as the lookup key.
 *
 * No auth token required — the provider signs the payload instead.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerId } = await params;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  let provider;
  try {
    provider = getProvider(providerId);
  } catch {
    return new Response(`Unknown provider: ${providerId}`, { status: 404 });
  }

  if (!provider.verifyWebhook(body)) {
    console.warn(`[banking/webhook/${providerId}] Signature verification failed`);
    return new Response("Invalid signature", { status: 401 });
  }

  const eventName = body.event_name as string | undefined;
  const metadata = (body.metadata ?? {}) as Record<string, unknown>;

  /** Helper: update a payment row by referenceId */
  async function updateByRef(referenceId: string, status: string, txHash?: string) {
    try {
      await db
        .update(payments)
        .set({
          status,
          ...(txHash ? { txHash } : {}),
        })
        .where(eq(payments.referenceId, referenceId));
    } catch (err) {
      console.error(`[webhook/${providerId}] DB update failed for ref=${referenceId}:`, err);
    }
  }

  // ── Collection events ──────────────────────────────────────────────────────
  if (eventName === "collection_completed") {
    const { collection_id, merchant_collection_id, amount, utr } = metadata;
    console.debug(`[webhook/${providerId}] collection_completed id=${collection_id} ref=${merchant_collection_id} amount=${amount} utr=${utr}`);
    if (merchant_collection_id) {
      await updateByRef(String(merchant_collection_id), "completed", utr ? String(utr) : undefined);
    }

  } else if (eventName === "collection_failed") {
    const { collection_id, merchant_collection_id, collection_failure_reason } = metadata;
    console.debug(`[webhook/${providerId}] collection_failed id=${collection_id} ref=${merchant_collection_id} reason=${collection_failure_reason}`);
    if (merchant_collection_id) {
      await updateByRef(String(merchant_collection_id), "failed");
    }

  // ── Onramp events ──────────────────────────────────────────────────────────
  } else if (eventName === "onramp_payment_received") {
    const { order_id } = metadata;
    console.debug(`[webhook/${providerId}] onramp_payment_received order=${order_id} — INR confirmed, crypto pending`);
    if (order_id) await updateByRef(String(order_id), "processing");

  } else if (eventName === "onramp_completed") {
    const { order_id, tx_hash } = metadata;
    console.debug(`[webhook/${providerId}] onramp_completed order=${order_id} tx=${tx_hash}`);
    if (order_id) await updateByRef(String(order_id), "completed", tx_hash ? String(tx_hash) : undefined);

  } else if (eventName === "onramp_expired") {
    const { order_id } = metadata;
    console.debug(`[webhook/${providerId}] onramp_expired order=${order_id}`);
    if (order_id) await updateByRef(String(order_id), "failed");

  } else if (eventName === "onramp_failed") {
    const { order_id, reason } = metadata;
    console.debug(`[webhook/${providerId}] onramp_failed order=${order_id} reason=${reason}`);
    if (order_id) await updateByRef(String(order_id), "failed");

  // ── Offramp events ─────────────────────────────────────────────────────────
  } else if (eventName === "offramp_deposit_detected") {
    const { order_id } = metadata;
    console.debug(`[webhook/${providerId}] offramp_deposit_detected order=${order_id} — crypto on-chain, awaiting confirmation`);
    if (order_id) await updateByRef(String(order_id), "processing");

  } else if (eventName === "offramp_payout_initiated") {
    const { order_id } = metadata;
    console.debug(`[webhook/${providerId}] offramp_payout_initiated order=${order_id} — INR payout submitted to bank`);
    if (order_id) await updateByRef(String(order_id), "processing");

  } else if (eventName === "offramp_completed") {
    const { order_id, payout_utr } = metadata;
    console.debug(`[webhook/${providerId}] offramp_completed order=${order_id} utr=${payout_utr}`);
    if (order_id) await updateByRef(String(order_id), "completed", payout_utr ? String(payout_utr) : undefined);

  } else if (eventName === "offramp_failed") {
    const { order_id, reason } = metadata;
    console.debug(`[webhook/${providerId}] offramp_failed order=${order_id} reason=${reason}`);
    if (order_id) await updateByRef(String(order_id), "failed");

  // ── Payout events ──────────────────────────────────────────────────────────
  } else if (eventName === "payout_completed") {
    const { merchant_payout_id, payout_id, transaction_reference_no } = metadata;
    console.debug(`[webhook/${providerId}] payout_completed id=${payout_id} ref=${merchant_payout_id} txref=${transaction_reference_no}`);
    if (merchant_payout_id) {
      await updateByRef(
        String(merchant_payout_id),
        "completed",
        transaction_reference_no ? String(transaction_reference_no) : undefined,
      );
    }

  } else if (eventName === "payout_failed") {
    const { merchant_payout_id, payout_id, payout_failure_reason } = metadata;
    console.debug(`[webhook/${providerId}] payout_failed id=${payout_id} ref=${merchant_payout_id} reason=${payout_failure_reason}`);
    if (merchant_payout_id) await updateByRef(String(merchant_payout_id), "failed");

  // ── Deposit events ─────────────────────────────────────────────────────────
  } else if (eventName === "new_deposit") {
    const { amount, currency, blockchain, sub_account_id, transaction_id } = metadata;
    console.debug(`[webhook/${providerId}] new_deposit amount=${amount} ${currency} blockchain=${blockchain} sub_account=${sub_account_id} tx=${transaction_id}`);
    // new_deposit is a credit event on the payout wallet — no matching pending row to update.
    // Log only (balance will reflect via the next balance refresh cycle).

  // ── Credit events ──────────────────────────────────────────────────────────
  } else if (eventName === "credit_limit_updated") {
    const { last_30_days_volume, new_credit_limit, old_credit_limit } = metadata;
    console.debug(`[webhook/${providerId}] credit_limit_updated old=${old_credit_limit} new=${new_credit_limit} vol30d=${last_30_days_volume}`);

  } else {
    console.debug(`[webhook/${providerId}] unknown event="${eventName}"`, metadata);
  }

  return new Response("OK", { status: 200 });
}
