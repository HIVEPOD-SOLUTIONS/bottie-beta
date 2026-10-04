/**
 * Example x402-protected seller endpoint using Circle Gateway nanopayments.
 *
 * GET /api/nanopay/sell
 *   - Without PAYMENT-SIGNATURE: returns 402 with PAYMENT-REQUIRED header
 *   - With valid PAYMENT-SIGNATURE: settles the payment and returns premium content
 *
 * Price: $0.000001 USDC (1 base unit) — Circle protocol minimum
 */

import { buildPaymentRequirements } from "@/lib/circle-gateway";

const PRICE_USD = 0.000001; // $0.000001 — Circle NanoPayments protocol minimum

function getSellerAddress(): string {
  const addr = process.env.CIRCLE_SELLER_ADDRESS;
  if (!addr) throw new Error("CIRCLE_SELLER_ADDRESS is not configured");
  return addr;
}

export async function GET(req: Request) {
  const resourceUrl = new URL(req.url).toString();
  const paymentSignature = req.headers.get("payment-signature");

  let requirements: Record<string, unknown>;
  let paymentRequired: Record<string, unknown>;

  try {
    ({ requirements, paymentRequired } = await buildPaymentRequirements(
      PRICE_USD,
      getSellerAddress(),
      resourceUrl,
    ));
  } catch (err: any) {
    return Response.json(
      { error: "Seller configuration error: " + (err?.message ?? "unknown") },
      { status: 500 },
    );
  }

  // No payment header — return 402 with payment requirements
  if (!paymentSignature) {
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString(
      "base64",
    );
    return new Response(JSON.stringify({ error: "Payment required" }), {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": encoded,
      },
    });
  }

  // Step 1: verify signature validity before committing any resources
  const { verifyPayment, settlePayment } = await import("@/lib/circle-gateway");
  const verification = await verifyPayment(paymentSignature, requirements);

  if (!verification.isValid) {
    return Response.json(
      { error: "Invalid payment signature", reason: verification.invalidReason },
      { status: 402 },
    );
  }

  // Step 2: serve content immediately — verification is sufficient proof of payment
  const response = Response.json(
    {
      content: "Payment confirmed via Circle Gateway nanopayments",
      paidBy: verification.payer,
      priceUSDC: PRICE_USD,
      chain: "Base",
    },
    {
      headers: {
        "PAYMENT-RESPONSE": Buffer.from(
          JSON.stringify({ success: true }),
        ).toString("base64"),
      },
    },
  );

  // Step 3: settle asynchronously — doesn't block the response
  settlePayment(paymentSignature, requirements).catch((err) =>
    console.error("[nanopay/sell] settle error:", err?.message),
  );

  return response;
}
