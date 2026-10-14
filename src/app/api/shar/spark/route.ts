import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { noteDevice } from "@/lib/abuse";
import { collectSpark } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * POST /api/shar/spark — collect today's Daily Spark: a few Shar once per UTC day, with a streak, a bonus every 7th day and a
 * multiplier for verified Seeker Genesis Token holders. Open to every signed-in user (Shar itself is not creator-only).
 * 409 when today's is already collected (or another account on this phone took it); 503 until drizzle/0016 has been applied.
 * The streak and the amount are worked out here; the app only shows them.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "shar-spark", 10, 1000);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  // Record the phone first, so the one-spark-per-phone rule can see it.
  await noteDevice(req, userId);
  try {
    const result = await collectSpark(userId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const { ok: _ok, ...spark } = result;
    return NextResponse.json({ spark }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[shar/spark]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't collect your spark right now." }, { status: 500 });
  }
}
