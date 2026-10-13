import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { reportChainPurchaseTransaction } from "@/lib/chain-purchase";

/**
 * POST /api/bitrefill/chain-purchase/{walletRequestId}/transaction  { txHash }
 *
 * Arc purchases only: reports the hash of the transaction the user's Bluvfi
 * wallet signed, so bluvfi-xrpl can track the LI.FI route to completion.
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
    await reportChainPurchaseTransaction(userId, id, body.txHash);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Couldn't report the transaction";
    console.error("[bitrefill/chain-purchase/transaction]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
