import { NextRequest, NextResponse } from "next/server";
import { getWalletRequest } from "@/lib/xrplBackend";
import { calculateXrpBalance } from "@/lib/xrplBalance";

/**
 * GET /api/xrpl/balance?walletRequestId=...
 *
 * XRP balance for a wallet, derived strictly through bluvfi-xrpl —
 * no direct call to the XRP Ledger or any other external service. Earlier
 * version of this route called xrplcluster.com's public RPC directly, which
 * worked but bypassed bluvfi-xrpl entirely; this is the corrected version.
 *
 * bluvfi-xrpl's own GET /wallet-requests/:id has no single "current balance"
 * field, so the balance is reconstructed from its activity history instead:
 *   + ACTIVATION_DEPOSIT_DETECTED, DEPOSIT_RECEIVED  (incoming)
 *   - INTERNAL_TRANSFER_SENT, RESERVE_RECOVERED       (outgoing)
 * This is exact for a plain (no-swap) wallet — the only kind used for the
 * sidebar wallet this route was built for. It would need SWAP_DEPOSIT_SUBMITTED
 * included in the outgoing sum too for a swap-enabled wallet, which this
 * route doesn't currently handle (not needed for its one caller today).
 */

export async function GET(req: NextRequest) {
  const walletRequestId = req.nextUrl.searchParams.get("walletRequestId");
  if (!walletRequestId) return NextResponse.json({ error: "walletRequestId is required" }, { status: 422 });

  try {
    const wallet = await getWalletRequest(walletRequestId);

    return NextResponse.json({
      walletRequestId,
      address: wallet.address,
      status: wallet.status,
      balanceXrp: calculateXrpBalance(wallet),
      activated: wallet.status !== "AWAITING_ACTIVATION",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch XRPL balance";
    const upstreamStatus = (err as { status?: number }).status;
    // Propagate 404 from the XRPL service as 404 so the client knows the
    // wallet request is orphaned and can stop retrying.
    const status = upstreamStatus === 404 ? 404 : 502;
    if (status !== 404) console.error("[xrpl/balance]", message);
    return NextResponse.json({ error: message }, { status });
  }
}
