/**
 * POST /api/roaster/battles/:id/back
 * Back a battle side with USDC. Returns a Solana transaction the backer must sign.
 * Fee: 1.25% of amount (0.25% creator / 0.60% rap creators / 0.30% protocol / 0.10% referral).
 * Earlier backing earns more — the pool is time-weighted.
 *
 * Body: { side (0|1), amount_usdc, backer_address, referrer_address? }
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
  const { side, amount_usdc, backer_address, referrer_address } = body;
  if (side !== 0 && side !== 1) return NextResponse.json({ error: "side must be 0 or 1" }, { status: 400 });
  if (!amount_usdc || Number(amount_usdc) <= 0)
    return NextResponse.json({ error: "amount_usdc must be a positive number" }, { status: 400 });
  if (!backer_address) return NextResponse.json({ error: "backer_address required" }, { status: 400 });
  try {
    const { backSide } = await import("@/lib/roaster");
    const result = await backSide({ battle_id, side, amount_usdc: Number(amount_usdc), backer_address, referrer_address });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
