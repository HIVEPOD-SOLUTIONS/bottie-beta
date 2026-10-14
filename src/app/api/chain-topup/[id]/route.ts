import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getTopUpStatus } from "@/lib/chain-topup";

/** GET /api/chain-topup/{walletRequestId} — progress of one of the user's own top-ups. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const { id } = await params;
  try {
    return NextResponse.json(await getTopUpStatus(userId, id));
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Status unavailable" }, { status: 502 });
  }
}
