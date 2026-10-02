/** GET /api/nosana/markets */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET() {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  try {
    const { listMarkets } = await import("@/lib/nosana");
    return NextResponse.json(await listMarkets());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
