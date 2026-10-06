import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getLeaderboard } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/** GET /api/shar/leaderboard — this week's top earners (anonymous handles only) and the caller's own rank. Resets Monday 00:00 UTC. */
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "shar-leaderboard", 30, 1000);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  try {
    return NextResponse.json(await getLeaderboard(userId), { headers: { "Cache-Control": "private, max-age=30" } });
  } catch (err) {
    console.error("[shar/leaderboard]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load the leaderboard right now." }, { status: 500 });
  }
}
