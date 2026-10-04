import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { grantChatBonus } from "@/lib/user-rate-limiter";

/**
 * POST /api/chat/bonus — extra chat messages after a rewarded ad.
 *
 * The server can't see the ad, so grants are bounded instead: each is at most MAX_BONUS_PER_GRANT messages and a user
 * gets a limited number per rolling 24h (see grantChatBonus). Verifying the ad itself needs AdMob server-side
 * verification.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
