/**
 * GET /api/nosana/credits          — balance
 * GET /api/nosana/credits?history  — spending history (pass ?history=1)
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { searchParams } = new URL(req.url);
  const history = searchParams.has("history");
  try {
    if (history) {
      const { getSpendingHistory } = await import("@/lib/nosana");
      const from = searchParams.get("from") ?? undefined;
      const to = searchParams.get("to") ?? undefined;
      const limitStr = searchParams.get("limit");
      const limit = limitStr ? Number(limitStr) : undefined;
      return NextResponse.json(await getSpendingHistory({ from, to, limit }));
    }
    const { getCredits } = await import("@/lib/nosana");
    return NextResponse.json(await getCredits());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
