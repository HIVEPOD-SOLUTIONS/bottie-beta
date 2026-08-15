/**
 * POST /api/grail/sell
 * Quote a gold sell and partner co-sign the transaction.
 * The returned cosigned_transaction must be signed by the user in the browser,
 * then submitted to /api/grail/sell/[id]/submit.
 *
 * Body: { grail_user_id, gold_amount, slippage_bps? }
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function POST(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { grail_user_id, gold_amount, slippage_bps } = await req.json().catch(() => ({}));
  if (!grail_user_id) return NextResponse.json({ error: "grail_user_id required" }, { status: 400 });
  if (!gold_amount || Number(gold_amount) <= 0)
    return NextResponse.json({ error: "gold_amount must be a positive number" }, { status: 400 });
  try {
    const { quoteSell } = await import("@/lib/grail");
    const result = await quoteSell(grail_user_id, Number(gold_amount), slippage_bps ?? 50);
    const { partially_signed_transaction: _, ...rest } = result;
    return NextResponse.json(rest);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
