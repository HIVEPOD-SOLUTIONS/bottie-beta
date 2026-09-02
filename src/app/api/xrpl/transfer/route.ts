import { and, eq } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { transferBetweenWallets, isXrplBackendConfigured } from "@/lib/xrplBackend";
import { db } from "@/lib/db";
import { bitrefillOrders } from "@/lib/db/schema";
import { walletRequestBelongsToUser, recoverXrpOrder } from "@/lib/xrp-purchase";

/**
 * POST /api/xrpl/transfer
 *
 * Sidebar-to-purchase transfer (guide step 6), and the reverse "recover
 * stuck funds" direction (bills-screen.tsx, and the AI's recover_xrp_order
 * tool). Moves XRP between two wallets this backend already holds, instead
 * of the user sending externally.
 *
 * The two directions are handled differently, not just by the same generic
 * path with different arguments:
 *
 * - Recovery (source resolves to a bitrefill_orders row owned by the
 *   caller): dispatched to recoverXrpOrder (src/lib/xrp-purchase.ts) — the
 *   same function the AI's recover_xrp_order tool calls directly. That
 *   function ALWAYS re-derives the recoverable amount live from bluvfi-xrpl
 *   and ALWAYS sends to the caller's own sidebar wallet, ignoring whatever
 *   amountXrp/destinationWalletRequestId the request body carries — a
 *   purchase wallet's only legitimate outbound use is recovering it back to
 *   its owner, so there's no case where a caller-supplied amount or
 *   destination for this direction should ever be trusted over the live,
 *   authoritative one.
 * - Ordinary funding (source is a sidebar wallet): the original generic
 *   path below — both wallets must belong to the caller (bluvfi-xrpl's own
 *   check only confirms source and destination belong to the same userId as
 *   *each other*, not that either belongs to whoever is actually calling
 *   this HTTP endpoint, since it's reached with a shared service API key,
 *   not per-user auth), and the caller-supplied amount is honored as
 *   before.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch (err) {
    return authErrorResponse(err);
  }

  if (!isXrplBackendConfigured()) {
    return Response.json({ error: "XRPL service not configured" }, { status: 501 });
  }

  let body: { sourceWalletRequestId?: string; destinationWalletRequestId?: string; amountXrp?: string | number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sourceWalletRequestId, destinationWalletRequestId, amountXrp } = body;
  if (!sourceWalletRequestId || !destinationWalletRequestId || !amountXrp) {
    return Response.json(
      { error: "sourceWalletRequestId, destinationWalletRequestId, and amountXrp are required" },
      { status: 422 },
    );
  }

  // Recovery-direction check: does the source resolve to one of the
  // caller's own purchase wallets? If so, this is unambiguously a recovery
  // call — dispatch to the shared, authoritative path instead of forwarding
  // the request body's amount/destination verbatim.
  const [sourceOrder] = await db
    .select({ id: bitrefillOrders.id })
    .from(bitrefillOrders)
    .where(and(eq(bitrefillOrders.xrplWalletRequestId, sourceWalletRequestId), eq(bitrefillOrders.userId, userId)))
    .limit(1);

  if (sourceOrder) {
    try {
      const result = await recoverXrpOrder(userId, sourceWalletRequestId);
      return Response.json({ message: "Recovered", amountDrops: String(Math.round(result.recoveredXrp * 1_000_000)) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Recovery failed";
      console.error("[xrpl/transfer] recovery error", message);
      return Response.json({ error: message }, { status: 502 });
    }
  }

  // ── Ordinary funding direction (sidebar → purchase) ───────────────────────
  const [ownsSource, ownsDestination] = await Promise.all([
    walletRequestBelongsToUser(sourceWalletRequestId, userId),
    walletRequestBelongsToUser(destinationWalletRequestId, userId),
  ]);
  if (!ownsSource || !ownsDestination) {
    return Response.json({ error: "Wallet not found" }, { status: 404 });
  }

  try {
    const result = await transferBetweenWallets(sourceWalletRequestId, destinationWalletRequestId, String(amountXrp));
    return Response.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Transfer failed";
    console.error("[xrpl/transfer]", message);
    return Response.json({ error: message }, { status: 502 });
  }
}
