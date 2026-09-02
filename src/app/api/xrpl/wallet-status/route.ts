import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getWalletRequest } from "@/lib/xrplBackend";
import { markXrpPurchaseFailed } from "@/lib/xrp-purchase";

const FAILURE_SWAP_STATUSES = new Set(["FAILED", "REFUNDED", "EXPIRED"]);

/**
 * GET /api/xrpl/wallet-status?walletRequestId=...
 *
 * Lightweight, dedicated check of a swap wallet's OWN status — strictly
 * through bluvfi-xrpl, no direct ledger/NEAR Intents calls. Exists because
 * the normal purchase-completion polling (pollInvoice, watching Bitrefill's
 * own invoice) has no visibility into the XRPL side at all: if the swap
 * fails (e.g. the underpayment guard refuses it — a real, confirmed
 * occurrence, not hypothetical), Bitrefill's invoice simply never receives
 * anything and stays "unpaid" until its own 15-minute window times out —
 * the user would sit looking at a stale "time left to send" countdown with
 * no indication their funds already hit a dead end. This route lets the UI
 * poll the swap's real status directly and surface that failure immediately.
 *
 * Also persists a detected failure server-side (via markXrpPurchaseFailed)
 * before responding — without this, the dashboard polling this route only
 * updated its own local React state to drive the error screen, never the
 * `payments`/`bitrefill_orders` rows themselves, so History (and the AI's
 * get_payment_history) would show the purchase stuck "pending" forever even
 * though the user was already looking at a clear failure screen.
 */
export async function GET(req: NextRequest) {
  try {
    await verifyAuth();
  } catch (err) {
    return authErrorResponse(err);
  }

  const walletRequestId = req.nextUrl.searchParams.get("walletRequestId");
  if (!walletRequestId) return NextResponse.json({ error: "walletRequestId is required" }, { status: 422 });

  try {
    const wallet = await getWalletRequest(walletRequestId);

    if (FAILURE_SWAP_STATUSES.has(wallet.swapStatus)) {
      const failStatus = wallet.swapStatus === "EXPIRED" ? "expired" : "failed";
      // Best-effort — a DB hiccup here shouldn't block the client from
      // seeing the failure status it asked for; the webhook and any other
      // poll of this same route will get another chance to persist it.
      markXrpPurchaseFailed(walletRequestId, failStatus).catch((e: unknown) =>
        console.error("[xrpl/wallet-status] markXrpPurchaseFailed error", e),
      );
    }

    return NextResponse.json({
      status: wallet.status,
      swapStatus: wallet.swapStatus,
      swapErrorMessage: wallet.swapErrorMessage,
      // The portion reserved for the swap — recoverable via transfer if the
      // swap failed/expired/was refunded, since it never left the wallet.
      // The base ~1.05 XRP reserve is not included and isn't recoverable
      // here (no completed swap, so bluvfi-xrpl's reserve-recovery sweep
      // never applies to this wallet).
      swapAmountDrops: wallet.swapAmountDrops,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch wallet status";
    console.error("[xrpl/wallet-status]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
