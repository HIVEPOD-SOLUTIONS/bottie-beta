import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { saveUserTx } from "@/lib/chain-swaps";

/**
 * POST /api/chain-swaps/{walletRequestId}/user-tx { txHash } — records the
 * hash of a payment the Bluvfi wallet sent to a deposit address (Robinhood
 * Chain), so the transfer is traceable if the swap ever needs checking.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { txHash?: string };
  if (!body.txHash) return NextResponse.json({ error: "txHash is required" }, { status: 422 });
  try {
    await saveUserTx(userId, id, body.txHash);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't save the transaction" }, { status: 400 });
  }
}
