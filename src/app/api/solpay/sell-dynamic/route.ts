/**
 * Solana DynamicGate — per-request variable pricing.
 *
 * GET /api/solpay/sell-dynamic?price=0.05
 *   • Price is resolved from the ?price= query param (falls back to $0.01 if absent/invalid)
 *   • Unpaid: 402 + challenge at the resolved price
 *   • Paid: { content, paidBy, priceUSDC }
 *
 * Gate "dynamic" is a DynamicGate registered in getSolPayKit() pricing catalogue.
 * The resolver runs per-request before the 402 challenge is issued.
 */

import { getSolPayKit } from "@/lib/solana-pay-kit";

export async function GET(req: Request) {
  let paykit: Awaited<ReturnType<typeof getSolPayKit>>;
  try {
    paykit = await getSolPayKit();
  } catch (err: unknown) {
    return Response.json(
      { error: "Seller configuration error: " + (err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }

  const resolvedPrice =
    new URL(req.url).searchParams.get("price") ?? "0.01";

  const handler = paykit.fetch(
    "dynamic",
    async (_req: Request, payment: { payer: string }) => {
      return Response.json({
        content: "Dynamic-priced payment confirmed on Solana",
        paidBy: payment.payer,
        priceUSDC: resolvedPrice,
      });
    },
  );

  return handler(req);
}
