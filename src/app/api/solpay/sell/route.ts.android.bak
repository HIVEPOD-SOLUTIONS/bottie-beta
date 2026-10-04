/**
 * Solana MPP charge gate — fixed $0.000001 USDC per call (protocol minimum).
 *
 * GET /api/solpay/sell
 *   • Unpaid: 402 + MPP challenge
 *   • Paid: { content, paidBy, priceUSDC, chain }
 *
 * Gate "charge" is registered in getSolPayKit() pricing catalogue.
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

  const handler = paykit.fetch(
    "charge",
    async (_req: Request, payment: { payer: string }) => {
      return Response.json({
        content: "Payment confirmed via Solana MPP nanopayments",
        paidBy: payment.payer,
        priceUSDC: 0.000001,
        chain: "Solana mainnet",
      });
    },
  );

  return handler(req);
}
