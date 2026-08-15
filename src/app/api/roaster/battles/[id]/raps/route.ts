/**
 * POST /api/roaster/battles/:id/raps
 * Submit angles for a battle side — AI writes bars and produces the full track.
 * The first creator to finish a side locks it (one song per side per battle).
 *
 * Body: { side (0|1), angles (string[]), creator_address }
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { id: battle_id } = await params;
  const body = await req.json().catch(() => ({}));
  const { side, angles, creator_address } = body;
  if (side !== 0 && side !== 1) return NextResponse.json({ error: "side must be 0 or 1" }, { status: 400 });
  if (!Array.isArray(angles) || angles.length === 0)
    return NextResponse.json({ error: "angles must be a non-empty array of strings" }, { status: 400 });
  if (!creator_address) return NextResponse.json({ error: "creator_address required" }, { status: 400 });
  try {
    const { createRap } = await import("@/lib/roaster");
    const rap = await createRap({ battle_id, side, angles, creator_address });
    return NextResponse.json(rap);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
