import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getEarnings } from "@/lib/earnings";
import { PAYMENTS } from "@/lib/payments-rules";
import { isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/** GET /api/earnings — an owner's commission from paid calls (available and lifetime), the withdrawal minimum, and their payouts. */
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "earnings", 60, 3000);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  try {
    return NextResponse.json({ ready: true, ...(await getEarnings(userId)) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (isMissingTable(err)) {
      return NextResponse.json({ ready: false, availableMicro: 0, lifetimeMicro: 0, minWithdrawMicro: PAYMENTS.minWithdrawMicro, ownerPct: PAYMENTS.ownerBps / 100, canWithdraw: false, open: null, payouts: [] });
    }
    console.error("[earnings]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load your earnings." }, { status: 500 });
  }
}
