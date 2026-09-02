import { NextRequest, NextResponse } from "next/server";
import { getWalletRequest } from "@/lib/xrplBackend";

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

const INCOMING_TYPES = new Set(["ACTIVATION_DEPOSIT_DETECTED", "DEPOSIT_RECEIVED"]);
const OUTGOING_TYPES = new Set(["INTERNAL_TRANSFER_SENT", "RESERVE_RECOVERED"]);

export async function GET(req: NextRequest) {
  const walletRequestId = req.nextUrl.searchParams.get("walletRequestId");
  if (!walletRequestId) return NextResponse.json({ error: "walletRequestId is required" }, { status: 422 });

  try {
    const wallet = await getWalletRequest(walletRequestId);

    let drops = 0;
    for (const activity of wallet.activities ?? []) {
      const a = activity as { type?: string; amountDrops?: string | null };
      if (!a.amountDrops) continue;
      const amt = Number(a.amountDrops);
      if (INCOMING_TYPES.has(a.type ?? "")) drops += amt;
      else if (OUTGOING_TYPES.has(a.type ?? "")) drops -= amt;
    }

    return NextResponse.json({
      walletRequestId,
      address: wallet.address,
      status: wallet.status,
      balanceXrp: drops / 1_000_000,
      activated: wallet.status !== "AWAITING_ACTIVATION",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch XRPL balance";
    console.error("[xrpl/balance]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
