import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getBalanceMicro, recentCreditActivity, sweepOrphanCalls } from "@/lib/credits";
import { PAYMENTS } from "@/lib/payments-rules";
import { isMissingTable } from "@/lib/shar";
import { getServerEnv } from "@/lib/server-env";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * GET /api/credits — the caller's prepaid balance for paid provider calls, where to send USDC to add more, and recent activity.
 * Any charge that was never settled nor refunded (the server died mid-call) is refunded here once it's old enough.
 */
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "credits", 60, 3000);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  try {
    await sweepOrphanCalls(userId);
    const [balanceMicro, activity] = await Promise.all([getBalanceMicro(userId), recentCreditActivity(userId)]);
    const depositAddress = getServerEnv("CREDITS_DEPOSIT_ADDRESS") ?? null;
    return NextResponse.json(
      { ready: true, enabled: !!depositAddress, balanceMicro, depositAddress, minTopupMicro: PAYMENTS.minTopupMicro, activity },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ ready: false, enabled: false, balanceMicro: 0, depositAddress: null, minTopupMicro: PAYMENTS.minTopupMicro, activity: [] });
    console.error("[credits]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load your credits." }, { status: 500 });
  }
}
