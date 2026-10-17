import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { friendlyXrpError, isXrplBackendConfigured } from "@/lib/xrplBackend";
import { fundTopUpFromXrpWallet } from "@/lib/chain-topup";

/**
 * POST /api/chain-topup/{walletRequestId}/fund-xrp — XRPL top-ups: pays the
 * swap wallet from the user's Bluvfi XRP wallet in one tap. The amount and
 * destination come from the user's own top-up row, never from the body.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  if (!isXrplBackendConfigured()) {
    return NextResponse.json({ error: "XRP payments aren't available right now." }, { status: 501 });
  }
  const { id } = await params;
  try {
    return NextResponse.json(await fundTopUpFromXrpWallet(userId, id));
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : "Couldn't send the XRP";
    console.error("[chain-topup/fund-xrp]", raw);
    return NextResponse.json({ error: friendlyXrpError(raw) }, { status: 400 });
  }
}
