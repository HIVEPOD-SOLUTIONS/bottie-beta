/**
 * Solana nanopayment discovery — OpenAPI 3.1 document.
 *
 * GET /api/solpay/openapi
 *   Returns an OpenAPI 3.1 spec with x-payment-info extensions for every
 *   gated Bluvfi Solana endpoint. Each route's payment offers (price, currency,
 *   protocol, intent) are embedded so buyers and wallets can discover payment
 *   requirements without hitting the gated endpoint first.
 *
 * Uses paykit.openapi() — resolves offers from the named gate catalogue,
 * expands multi-stablecoin offers (USDC, PYUSD, USDT), and stamps the
 *   correct protocol (mpp / x402) per gate type.
 */

import { getSolPayKit } from "@/lib/solana-pay-kit";

export async function GET() {
  let paykit: Awaited<ReturnType<typeof getSolPayKit>>;
  try {
    paykit = await getSolPayKit();
  } catch (err: unknown) {
    return Response.json(
      { error: "Seller configuration error: " + (err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type OpenApiRoute = { gate: string; method: "GET" | "POST"; path: string; requestBody?: Record<string, unknown>; summary?: string };

  const routes: OpenApiRoute[] = [
    {
      gate: "charge",
      method: "GET",
      path: "/api/solpay/sell",
      summary: "Fixed $0.000001 USDC per call — MPP charge gate (protocol minimum)",
    },
    {
      gate: "metered",
      method: "POST",
      path: "/api/solpay/sell-usage",
      summary: "Metered billing $0.001/word, max $0.10 — x402 usage gate",
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
      },
    },
    {
      gate: "weekly",
      method: "GET",
      path: "/api/solpay/sell-subscription",
      summary: "$0.25 USDC/week recurring — MPP subscription gate (planId: bluvfi-weekly-v1)",
    },
    {
      gate: "dynamic",
      method: "GET",
      path: "/api/solpay/sell-dynamic",
      summary: "Variable price from ?price= query param — MPP DynamicGate",
    },
    ...(process.env.SOLANA_FEE_RECIPIENT
      ? [{
          gate: "charge-with-fee",
          method: "GET" as const,
          path: "/api/solpay/sell-with-fee",
          summary: "$0.0000011 total: $0.000001 seller + $0.0000001 platform fee — MPP feeOnTop charge gate",
        }]
      : []),
  ];

  try {
    const doc = await paykit.openapi(routes, {
      info: { title: "Bluvfi Solana Payments", version: "1.0.0" },
    });
    return Response.json(doc, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (err: unknown) {
    return Response.json(
      { error: "Failed to build OpenAPI document: " + (err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
