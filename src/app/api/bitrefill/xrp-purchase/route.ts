import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { isXrplBackendConfigured } from "@/lib/xrplBackend";
import { initiateXrpPurchase, type UnderlyingMethod } from "@/lib/xrp-purchase";

/**
 * POST /api/bitrefill/xrp-purchase
 *
 * Dashboard entry point for "pay with XRP" (guide step 5). Runs the full
 * create-invoice → quote → create-swap-wallet chain server-side in one call
 * (BLUVFI_XRPL_API_KEY never reaches the client), then returns everything
 * bills-screen.tsx needs to render the same deposit-address UI used for
 * other address-based methods (BTC, TON, etc.) — address, amount, deadline.
 */
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch (err) {
    return authErrorResponse(err);
  }

  if (!isXrplBackendConfigured()) {
    return NextResponse.json({ error: "XRPL service not configured" }, { status: 501 });
  }

  let body: {
    productId?: string;
    packageId?: string;
    /** Range products (e.g. "NGN 5–50000"): the custom amount the user typed, no fixed packageId available */
    customValue?: number;
    recipientEmail?: string;
    recipientName?: string;
    sendTo?: string;
    underlyingMethod?: UnderlyingMethod;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.productId) return NextResponse.json({ error: "productId is required" }, { status: 422 });

  // Same resolution order as /api/bitrefill/invoice: fixed packageId first,
  // fall back to the range/custom amount for products with no fixed packages.
  const resolvedPackageId = body.packageId ?? (body.customValue != null ? String(body.customValue) : "");
  if (!resolvedPackageId) {
    return NextResponse.json({ error: "packageId or customValue is required" }, { status: 422 });
  }

  try {
    const result = await initiateXrpPurchase({
      productId: body.productId,
      packageId: resolvedPackageId,
      privyDid: userId,
      recipientEmail: body.recipientEmail,
      recipientName: body.recipientName,
      sendTo: body.sendTo,
      underlyingMethod: body.underlyingMethod,
    });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "XRP purchase failed";
    console.error("[bitrefill/xrp-purchase]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
