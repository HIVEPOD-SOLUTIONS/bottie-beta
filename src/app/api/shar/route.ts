import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getSummary } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * GET /api/shar — the signed-in user's Shar: available and pending balance, tier, weekly total, referral code, claim state
 * and recent activity. Spending Shar is derived from `payments` on every read (see src/lib/shar-rules.ts).
 */
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "shar", 60, 3000);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  try {
    return NextResponse.json(await getSummary(userId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[shar]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load Shar right now." }, { status: 500 });
  }
}
