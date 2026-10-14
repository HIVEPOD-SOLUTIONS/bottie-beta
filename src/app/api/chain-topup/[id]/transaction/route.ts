import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { reportTopUpTransaction } from "@/lib/chain-topup";

/** POST /api/chain-topup/{walletRequestId}/transaction { txHash } — Arc / Tempo top-ups report their signed hash. */
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
    await reportTopUpTransaction(userId, id, body.txHash);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't report the transaction" }, { status: 400 });
  }
}
