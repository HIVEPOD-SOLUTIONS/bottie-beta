import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { pushConfigured, registerPushToken, unregisterPushToken } from "@/lib/push";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * POST   /api/push/register — { token }: this phone's Firebase Cloud Messaging token, so the server can tell the person their claim was
 *                              paid or their provider was used. The person turns this on in the app (Daily Spark, Reminders and alerts).
 * DELETE /api/push/register — { token }: switch it off for this phone.
 * `configured` says whether the server can send yet (it needs FCM_SERVICE_ACCOUNT_JSON); registering works either way.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "push-register", 10, 100);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    const result = await registerPushToken(userId, body?.token);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, configured: pushConfigured() });
  } catch (err) {
    console.error("[push/register]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't turn notifications on right now." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
  try {
    await unregisterPushToken(userId, body?.token);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[push/register]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't turn notifications off right now." }, { status: 500 });
  }
}
