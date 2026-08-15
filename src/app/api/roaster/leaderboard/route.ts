/**
 * GET /api/roaster/leaderboard
 * Query params: limit, offset, metric (earnings | wins | battles_created)
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  try {
    const { searchParams } = new URL(req.url);
    const { getLeaderboard } = await import("@/lib/roaster");
    const data = await getLeaderboard({
      limit: searchParams.has("limit") ? Number(searchParams.get("limit")) : 20,
      offset: searchParams.has("offset") ? Number(searchParams.get("offset")) : undefined,
      metric: (searchParams.get("metric") as any) ?? undefined,
    });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
