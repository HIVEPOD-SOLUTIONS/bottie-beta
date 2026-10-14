import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { createInboxKey, revokeInboxKey } from "@/lib/inbox";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * POST   /api/notifications/key — turn alerts on for this phone. Returns { key, cursor } ONCE: the key is what the phone reads its inbox with
 *                                 (only a hash is kept here) and the cursor is where the inbox is now, so only new alerts are shown.
 * DELETE /api/notifications/key — { key }: turn alerts off for this phone.
 * There is no push service behind this and nothing to set up: the phone asks for its alerts (see /api/notifications/inbox).
 */
export async function POST() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "inbox-key", 10, 100);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  try {
    const made = await createInboxKey(userId);
    if (!made.ok) return NextResponse.json({ error: made.error }, { status: made.status });
    return NextResponse.json({ key: made.key, cursor: made.cursor }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[notifications/key]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't turn alerts on right now." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
  try {
    await revokeInboxKey(userId, body?.key);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[notifications/key]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't turn alerts off right now." }, { status: 500 });
  }
}
