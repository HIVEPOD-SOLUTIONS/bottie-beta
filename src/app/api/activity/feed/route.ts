import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getActivity } from "@/lib/activity-feed";
import { parseCursor, parseLimit, parseSource } from "@/lib/activity-rules";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * GET /api/activity/feed?source=all|shar|credits|commission&limit=25&cursor=...
 * The signed-in user's whole history, newest first: Shar (purchases, provider use, claims), credits (top-ups, paid calls, refunds)
 * and commission (what their providers earned, withdrawals). Pass the returned nextCursor back to get the next page.
 */
export async function GET(req: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "activity", 60, 2000);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });

  const params = req.nextUrl.searchParams;
  const rawCursor = params.get("cursor");
  const cursor = rawCursor ? parseCursor(rawCursor) : null;
  if (rawCursor && !cursor) return NextResponse.json({ error: "That page marker isn't valid." }, { status: 400 });
  try {
    const page = await getActivity(userId, { source: parseSource(params.get("source")), limit: parseLimit(params.get("limit")), cursor });
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[activity]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load your activity right now." }, { status: 500 });
  }
}
