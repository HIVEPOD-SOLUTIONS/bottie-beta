/**
 * POST /api/grail/buy
 * Quote a gold buy and partner co-sign the transaction.
 * The returned cosigned_transaction must be signed by the user in the browser,
 * then submitted to /api/grail/buy/[id]/submit.
 *
 * Body: { grail_user_id, usdc_amount, slippage_bps? }
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function POST(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { grail_user_id, usdc_amount, slippage_bps } = await req.json().catch(() => ({}));
  if (!grail_user_id) return NextResponse.json({ error: "grail_user_id required" }, { status: 400 });
  if (!usdc_amount || Number(usdc_amount) <= 0)
    return NextResponse.json({ error: "usdc_amount must be a positive number" }, { status: 400 });
  try {
    const { quoteBuy } = await import("@/lib/grail");
    const result = await quoteBuy(grail_user_id, Number(usdc_amount), slippage_bps ?? 50);
    // Strip raw partially_signed_transaction — frontend only needs the cosigned version
    const { partially_signed_transaction: _, ...rest } = result;
    return NextResponse.json(rest);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
