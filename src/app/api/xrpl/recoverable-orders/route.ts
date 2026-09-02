import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { isXrplBackendConfigured } from "@/lib/xrplBackend";
import { listRecoverableXrpOrders } from "@/lib/xrp-purchase";

/**
 * GET /api/xrpl/recoverable-orders
 *
 * Lists this user's "pay with XRP" purchases that failed AFTER the deposit
 * wallet was already funded — meaning real XRP is sitting in a wallet this
 * backend controls, un-recovered.
 *
 * Exists because the only recovery UI before this (bills-screen.tsx's
 * "Recover your XRP" button) lived entirely in that one component's live,
 * in-session React state — populated in exactly one place, right after a
 * purchase started in that same browser session. It was never reachable for
 * a purchase made through the AI, or a dashboard purchase where the user
 * navigated away before the failure was caught live — the funds stayed
 * genuinely safe, but the app gave no way to actually move them. This route
 * (and the list UI it feeds in bills-screen.tsx's "My Bills" tab) reads the
 * DB instead of live component state, so it works regardless of how or when
 * the purchase was made.
 *
 * Thin wrapper — see listRecoverableXrpOrders (src/lib/xrp-purchase.ts) for
 * the actual logic, shared with the AI's list_recoverable_xrp tool.
 */
export async function GET() {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch (err) {
    return authErrorResponse(err);
  }

  if (!isXrplBackendConfigured()) {
    return NextResponse.json({ orders: [] });
  }

  const orders = await listRecoverableXrpOrders(userId).catch(() => []);
  return NextResponse.json({ orders });
}
