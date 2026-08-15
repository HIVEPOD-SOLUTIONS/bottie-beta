import { NextRequest, NextResponse } from "next/server";
import { mcpBuyProducts } from "@/lib/bitrefill-mcp";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { bitrefillOrders, payments } from "@/lib/db/schema";

/**
 * POST /api/bitrefill/invoice
 *
 * Creates a Bitrefill invoice via the @bitrefill/cli guest checkout path.
 * No Bitrefill account required — code is delivered to recipientEmail.
 *
 * Body:
 *   productId       — Bitrefill product id (e.g. "netflix-us")
 *   packageId       — package_value from get-product-details (e.g. "15")
 *   paymentMethod   — "usdc_base" | "usdc_solana" | "balance" | … (default: "usdc_base")
 *   recipientEmail  — email to deliver the code to (guest checkout)
 *   recipientName   — optional display name
 *   sendTo          — phone number for mobile top-ups (E.164)
 */
export async function POST(req: NextRequest) {
  // Auth — required so we can scope DB records to a verified user
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch (err) {
    return authErrorResponse(err);
  }

  let body: {
    productId: string;
    packageId: string;
    paymentMethod?: string;
    recipientEmail?: string;
    recipientName?: string;
    sendTo?: string;
    packageAmount?: number;
    customValue?: number;
    /** Bill-payment prepayment ID returned by submit-prepayment-step (MCP only) */
    billPaymentId?: string;
    /** Gift delivery — email the product to someone else */
    gift?: {
      recipient_name: string;
      recipient_email: string;
      sender_name: string;
      message?: string;
      theme?: string;
    };
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { productId, packageId, paymentMethod, recipientEmail, recipientName, sendTo, billPaymentId, gift } = body;

  if (!productId) {
    return NextResponse.json({ error: "productId is required" }, { status: 400 });
  }
  if (!packageId && !body.packageAmount && !body.customValue) {
    return NextResponse.json({ error: "packageId is required" }, { status: 400 });
  }

  const resolvedPackageId = packageId ?? String(body.packageAmount ?? body.customValue ?? "");

  // Link-only methods (fiat, exchange pay) need the web checkout URL.
  // All crypto methods — whether we pay via ArcKit or show a deposit address —
  // need the raw payment_info (address + amount), so returnPaymentLink must be false.
  const LINK_ONLY_METHODS = new Set([
    "fiat_card", "google_pay", "apple_pay", "ideal", "eps", "p24", "bancontact",
    "binance_pay", "kraken_pay",
  ]);
  const pm = paymentMethod ?? "usdc_base";
  const returnPaymentLink = LINK_ONLY_METHODS.has(pm);

  try {
    const invoice = await mcpBuyProducts({
      productId,
      packageId:     resolvedPackageId,
      paymentMethod: pm,
      recipientEmail,
      recipientName,
      refillInput:   sendTo,
      gift,
      returnPaymentLink,
    });

    // ── Persist pending invoice to DB ────────────────────────────────────────
    // Write immediately so there is always a DB record, even if the user's
    // ArcKit send succeeds but the subsequent poll (handlePurchased) fails.
    const invoiceId: string = (invoice as any)?.id ?? (invoice as any)?.invoiceId ?? "";
    const productName: string | undefined = (invoice as any)?.product?.name ?? (invoice as any)?.productName;
    const payInfo = (invoice as any)?.payment_info ?? {};
    const isAddressBased: boolean = !!(invoice as any)?.payment_info?.address;
    const paymentAddress: string | undefined = payInfo?.address;
    const paymentAmount: string | undefined = payInfo?.amount != null ? String(payInfo.amount) : undefined;
    const paymentCurrency: string | undefined = payInfo?.currency;
    // Estimate USDC amount from package value (packageId is the denomination in USD for gift cards)
    const amountUsdcEst = resolvedPackageId && !isNaN(Number(resolvedPackageId))
      ? resolvedPackageId
      : payInfo?.price_usdc ?? null;
    const chain = pm.includes("solana") ? "solana" : "evm";

    if (invoiceId) {
      // bitrefill_orders: upsert so a duplicate call doesn't throw
      db.insert(bitrefillOrders).values({
        userId,
        invoiceId,
        productId,
        productName: productName ?? null,
        packageValue: resolvedPackageId,
        paymentMethod: pm,
        isAddressBased,
        paymentAddress: paymentAddress ?? null,
        paymentAmount: paymentAmount ?? null,
        paymentCurrency: paymentCurrency ?? null,
        amountUsdc: amountUsdcEst ? String(amountUsdcEst) : null,
        recipientEmail: recipientEmail ?? null,
        chain,
        status: "pending",
      }).onConflictDoNothing().catch(() => {});

      // payments: pending bill row — bills-screen updates to completed on poll success
      db.insert(payments).values({
        userId,
        type: "bill",
        referenceId: invoiceId,
        description: `Bitrefill ${productName ?? productId} ×${resolvedPackageId}${recipientEmail ? ` → ${recipientEmail}` : ""}`,
        amountUsdc: amountUsdcEst ? String(amountUsdcEst) : "0",
        status: "pending",
        chain,
      }).catch(() => {});
    }

    return NextResponse.json(invoice);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invoice creation failed";
    console.error("[/api/bitrefill/invoice POST]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
