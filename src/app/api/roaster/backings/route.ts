/**
 * GET /api/roaster/backings — list a user's battle backings
 * Query params: backer_address (required), battle_id?, limit?
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { searchParams } = new URL(req.url);
  const backer_address = searchParams.get("backer_address");
  if (!backer_address) return NextResponse.json({ error: "backer_address required" }, { status: 400 });
  try {
    const { getMyBackings } = await import("@/lib/roaster");
    const data = await getMyBackings({
      backer_address,
      battle_id: searchParams.get("battle_id") ?? undefined,
      limit: searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined,
    });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
