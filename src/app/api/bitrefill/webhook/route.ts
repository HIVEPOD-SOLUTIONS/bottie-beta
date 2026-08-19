import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { bitrefillOrders, payments } from "@/lib/db/schema";

/**
 * POST /api/bitrefill/webhook
 *
 * Bitrefill calls this URL when an invoice reaches a terminal state:
 *   complete | denied | payment_error
 *
 * The body is the full invoice JSON (same shape as GET /invoices/{id} response).
 * We MUST respond with 200 within 5 seconds or Bitrefill will retry.
 *
 * Webhook URL is passed as `webhook_url` in buy-products and is only set when
 * NEXT_PUBLIC_APP_URL is a public HTTPS URL (not localhost).
 *
 * Optional signature verification: set BITREFILL_WEBHOOK_SECRET in env.
 * When set, Bitrefill signs the payload with HMAC-SHA256 and sends the
 * hex digest in the `X-Bitrefill-Signature` header.
 */
export async function POST(req: NextRequest) {
  // ── 0. Optional HMAC signature verification ──────────────────────────────────
  const secret = process.env.BITREFILL_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers.get("x-bitrefill-signature") ?? "";
    if (!sig) {
      console.warn("[bitrefill/webhook] missing signature header — rejecting");
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    const body = await req.text();
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(body);
    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const rawSig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const expected = Array.from(new Uint8Array(rawSig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (expected !== sig) {
      console.warn("[bitrefill/webhook] signature mismatch — rejecting");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    // body already consumed; parse it now
    try {
      return handleWebhook(JSON.parse(body));
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  // ── No secret — parse directly ───────────────────────────────────────────────
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  return handleWebhook(payload);
}

async function handleWebhook(payload: unknown): Promise<NextResponse> {
  const inv = payload as Record<string, unknown>;

  // Support both REST API shape (id/status) and MCP TOON shape (invoice_id/invoice_status)
  const invoiceId: string = String(
    inv.invoice_id ?? inv.id ?? "",
  );

  if (!invoiceId) {
    console.error("[bitrefill/webhook] no invoice_id in payload", inv);
    // Return 200 anyway — Bitrefill must not retry for malformed bodies
    return NextResponse.json({ ok: true });
  }

  // invoice_status (MCP get-invoice-by-id) or status (REST API)
  const rawStatus: string = String(inv.invoice_status ?? inv.status ?? "");

  // Normalise to our DB status vocabulary: "complete" | "failed" | "expired" | "pending"
  const terminalMap: Record<string, string> = {
    complete:      "complete",
    denied:        "failed",
    payment_error: "failed",
    failed:        "failed",
    expired:       "expired",
    cancelled:     "expired",
    refunded:      "expired",
  };
  const dbStatus = terminalMap[rawStatus];

  if (!dbStatus) {
    // Non-terminal state — Bitrefill shouldn't call us for these, but ack anyway
    console.log(`[bitrefill/webhook] non-terminal status "${rawStatus}" for ${invoiceId} — ignoring`);
    return NextResponse.json({ ok: true });
  }

  // ── Extract redemption code from the orders array ─────────────────────────
  const orders: unknown[] = Array.isArray(inv.orders) ? inv.orders : [];
  let redemptionCode: string | null = null;
  let esimInstallLink: string | null = null;

  for (const o of orders) {
    const order = o as Record<string, unknown>;
    const ri = (order.redemption_info ?? {}) as Record<string, unknown>;
    const code =
      ri.code ??
      ri.pin ??
      ri.link ??
      order.code ??
      order.pin ??
      order.access_link ??
      null;
    if (code && !redemptionCode) redemptionCode = String(code);

    const esim = order.esim_install_link as string | undefined;
    if (esim && !esimInstallLink) esimInstallLink = esim;
  }

  // Also check top-level esim_install_links (buy-products can put them there)
  if (!esimInstallLink && Array.isArray(inv.esim_install_links)) {
    esimInstallLink = String((inv.esim_install_links as unknown[])[0] ?? "") || null;
  }

  console.log(`[bitrefill/webhook] invoice=${invoiceId} status=${rawStatus}→${dbStatus} code=${redemptionCode ? "present" : "none"}`);

  // ── Update bitrefill_orders ───────────────────────────────────────────────
  db.update(bitrefillOrders)
    .set({
      status: dbStatus,
      ...(redemptionCode ? { redemptionCode }      : {}),
      ...(esimInstallLink ? { esimInstallLink }     : {}),
      updatedAt: new Date(),
    })
    .where(eq(bitrefillOrders.invoiceId, invoiceId))
    .catch((e: unknown) => console.error("[bitrefill/webhook] bitrefill_orders update error", e));

  // ── Update payments ───────────────────────────────────────────────────────
  const paymentStatus = dbStatus === "complete" ? "completed" : "failed";
  db.update(payments)
    .set({ status: paymentStatus })
    .where(eq(payments.referenceId, invoiceId))
    .catch((e: unknown) => console.error("[bitrefill/webhook] payments update error", e));

  return NextResponse.json({ ok: true });
}
