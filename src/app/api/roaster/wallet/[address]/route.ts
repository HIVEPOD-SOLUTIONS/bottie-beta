/**
 * GET /api/roaster/wallet/:address — get Battle Wallet balance and pending payouts
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { address } = await params;
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
  try {
    const { getBattleWallet } = await import("@/lib/roaster");
    const wallet = await getBattleWallet(address);
    return NextResponse.json(wallet);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
