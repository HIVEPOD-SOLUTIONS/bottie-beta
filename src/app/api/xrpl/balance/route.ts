import { NextRequest, NextResponse } from "next/server";
import { getWalletRequest, recheckWalletRequest } from "@/lib/xrplBackend";
import { calculateXrpBalance } from "@/lib/xrplBalance";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { xrplSidebarWallets } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { walletRequestBelongsToUser } from "@/lib/xrp-purchase";

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
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch (err) {
    return authErrorResponse(err);
  }

  let walletRequestId = req.nextUrl.searchParams.get("walletRequestId");
  if (walletRequestId) {
    if (!(await walletRequestBelongsToUser(walletRequestId, userId))) {
      return NextResponse.json({ error: "Wallet not found", code: "NO_WALLET" }, { status: 404 });
    }
  } else {
    const [sidebarWallet] = await db
      .select({ walletRequestId: xrplSidebarWallets.walletRequestId })
      .from(xrplSidebarWallets)
      .where(eq(xrplSidebarWallets.userId, userId))
      .limit(1);
    if (!sidebarWallet) return NextResponse.json({ error: "XRP wallet not found", code: "NO_WALLET" }, { status: 404 });
    walletRequestId = sidebarWallet.walletRequestId;
  }

  try {
    // ?refresh=1 — asked for right after something that just moved XRP
    // (a transfer/recovery) or when the user opens their wallet. Makes
    // bluvfi-xrpl re-check the ledger now instead of waiting for its next
    // ~30s reconciliation sweep, so a fresh deposit shows up in seconds.
    // Best-effort: a failed recheck must never block returning the balance
    // we already have. Not used by the periodic poll, to avoid hammering
    // the ledger on a timer.
    if (req.nextUrl.searchParams.get("refresh") === "1") {
      await recheckWalletRequest(walletRequestId).catch(() => {});
    }
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
    return NextResponse.json({ error: message, ...(status === 404 ? { code: "ORPHANED" } : {}) }, { status });
  }
}
