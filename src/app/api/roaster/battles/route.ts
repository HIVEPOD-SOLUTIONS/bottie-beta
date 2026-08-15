/**
 * GET  /api/roaster/battles — list battles (status, limit, offset, creator_address)
 * POST /api/roaster/battles — create battle (topic, side_a_name, side_b_name, duration_tier, creator_address)
 *   Returns bond_transaction — user must sign it to transfer the 10 USDC creation bond.
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  try {
    const { searchParams } = new URL(req.url);
    const { listBattles } = await import("@/lib/roaster");
    const data = await listBattles({
      status: searchParams.get("status") as any ?? undefined,
      limit: searchParams.has("limit") ? Number(searchParams.get("limit")) : 20,
      offset: searchParams.has("offset") ? Number(searchParams.get("offset")) : undefined,
      creator_address: searchParams.get("creator_address") ?? undefined,
    });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const body = await req.json().catch(() => ({}));
  const { topic, side_a_name, side_b_name, duration_tier, creator_address } = body;
  if (!topic) return NextResponse.json({ error: "topic required" }, { status: 400 });
  if (!side_a_name || !side_b_name) return NextResponse.json({ error: "side_a_name and side_b_name required" }, { status: 400 });
  if (!duration_tier || !["15m", "6h", "24h"].includes(duration_tier))
    return NextResponse.json({ error: "duration_tier must be 15m, 6h, or 24h" }, { status: 400 });
  if (!creator_address) return NextResponse.json({ error: "creator_address required" }, { status: 400 });
  try {
    const { createBattle } = await import("@/lib/roaster");
    const result = await createBattle({ topic, side_a_name, side_b_name, duration_tier, creator_address });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
