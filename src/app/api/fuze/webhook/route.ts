import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

function timingSafeEqualHex(a: string, b: string) {
  const left = Buffer.from(a.replace(/^sha256=/, ""), "hex");
  const right = Buffer.from(b.replace(/^sha256=/, ""), "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyWebhook(rawBody: string, req: NextRequest) {
  const secret = process.env.FUZE_WEBHOOK_SECRET;
  // Reject ALL requests when the secret is not configured — never silently allow
  // unauthenticated webhook calls in production. Set FUZE_WEBHOOK_SECRET to enable.
  if (!secret) return { ok: false, configured: false, reason: "Webhook not configured" };

  const signature =
    req.headers.get("x-fuze-signature") ??
    req.headers.get("x-signature") ??
    req.headers.get("x-webhook-signature");

  if (!signature) return { ok: false, configured: true, reason: "Missing signature" };

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return {
    ok: timingSafeEqualHex(signature, expected),
    configured: true,
    reason: "Invalid signature",
  };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const verification = verifyWebhook(rawBody, req);

  if (!verification.ok) {
    return NextResponse.json({ error: verification.reason ?? "Invalid webhook" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = payload as {
    event?: { entity?: string; eventType?: string; updatedAt?: string };
    data?: { status?: string; userStatus?: string; clientOrderId?: string; orgUserId?: string };
  };

  const normalized = {
    provider: "fuze",
    entity: event.event?.entity ?? "unknown",
    eventType: event.event?.eventType ?? "unknown",
    status: event.data?.status ?? event.data?.userStatus ?? null,
    clientOrderId: event.data?.clientOrderId ?? null,
    orgUserId: event.data?.orgUserId ?? null,
    updatedAt: event.event?.updatedAt ?? new Date().toISOString(),
    signatureVerified: verification.configured,
  };

  console.info("[Fuze webhook]", normalized);

  return NextResponse.json({ received: true, event: normalized });
}
