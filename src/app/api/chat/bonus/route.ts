import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { adSsvEnforced, claimVerifiedBonus, grantChatBonus } from "@/lib/user-rate-limiter";

/**
 * POST /api/chat/bonus — extra chat messages after a rewarded ad.
 *
 * Two modes, chosen by the server's ADMOB_SSV_ENABLED switch:
 *
 *  • SSV on  — a bonus needs an ad Google has confirmed through the signed callback (/api/admob/ssv). The app calls
 *    this after the ad and polls: 202 {pending:true} until Google's callback has arrived, then 200 {granted}.
 *  • SSV off — the original behaviour, bounded: each grant is at most MAX_BONUS_PER_GRANT messages and a user gets a
 *    limited number per rolling 24h. The server can't see the ad in this mode, so it's a ceiling, not proof.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (adSsvEnforced()) {
    const claim = await claimVerifiedBonus(userId);
    if (claim.granted > 0) return NextResponse.json({ granted: claim.granted });
    if (claim.capped) {
      return NextResponse.json(
        { error: "You've used all of today's ad bonuses. Try again tomorrow.", granted: 0 },
        { status: 429 },
      );
    }
    return NextResponse.json({ pending: true, granted: 0 }, { status: 202 });
  }

  const body = await req.json().catch(() => ({}));
  const requested = typeof body?.amount === "number" && body.amount > 0 ? body.amount : 5;

  const granted = await grantChatBonus(userId, requested);
  if (granted === 0) {
    return NextResponse.json(
      { error: "You've used all of today's ad bonuses. Try again tomorrow.", granted: 0 },
      { status: 429 },
    );
  }
  return NextResponse.json({ granted });
}
