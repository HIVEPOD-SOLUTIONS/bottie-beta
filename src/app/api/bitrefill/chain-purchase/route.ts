import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { isXrplBackendConfigured } from "@/lib/xrplBackend";
import { initiateChainPurchase, isPurchaseChain } from "@/lib/chain-purchase";

/**
 * POST /api/bitrefill/chain-purchase
 *
 * Bitrefill checkout paid with Zcash, Hyperliquid USDC or Arc USDC (see
 * src/lib/chain-purchase.ts). Creates the invoice and the bluvfi-xrpl swap in
 * one call; BLUVFI_XRPL_API_KEY never reaches the client.
 *
 * Body: { chain, refundAddress, productId, packageId | customValue,
 *         recipientEmail?, recipientName?, sendTo? }
 */
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  if (!isXrplBackendConfigured()) {
    return NextResponse.json({ error: "This payment method isn't available right now." }, { status: 501 });
  }

  let body: {
    chain?: string;
    refundAddress?: string;
    productId?: string;
    packageId?: string;
    customValue?: number;
    recipientEmail?: string;
    recipientName?: string;
    sendTo?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isPurchaseChain(body.chain)) return NextResponse.json({ error: "chain must be zcash, hyperliquid or arc" }, { status: 422 });
  if (!body.refundAddress) return NextResponse.json({ error: "refundAddress is required" }, { status: 422 });
  if (!body.productId) return NextResponse.json({ error: "productId is required" }, { status: 422 });
  const packageId = body.packageId ?? (body.customValue != null ? String(body.customValue) : "");
  if (!packageId) return NextResponse.json({ error: "packageId or customValue is required" }, { status: 422 });

  try {
    const result = await initiateChainPurchase({
      chain: body.chain,
      refundAddress: body.refundAddress,
      productId: body.productId,
      packageId,
      privyDid: userId,
      recipientEmail: body.recipientEmail,
      recipientName: body.recipientName,
      sendTo: body.sendTo,
    });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Purchase failed";
    console.error("[bitrefill/chain-purchase]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
