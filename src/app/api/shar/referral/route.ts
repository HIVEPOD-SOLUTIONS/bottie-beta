import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { attachReferral, isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/** POST /api/shar/referral  { code: string } — record who referred you. Once only, never your own code. */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "shar-referral", 5, 30);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await attachReferral(userId, body?.code);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "Referrals are being set up. Try again soon." }, { status: 503 });
    console.error("[shar/referral]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save that code." }, { status: 500 });
  }
}
