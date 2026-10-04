/**
 * Solana MPP subscription gate — $0.25 USDC/week recurring.
 *
 * GET /api/solpay/sell-subscription
 *   • Non-subscriber: 402 + MPP subscription challenge
 *   • Active subscriber: content served immediately (no per-call charge within the week)
 *
 * Plan: bluvfi-weekly-v1, 1-week period. The puller (operator) debits renewals.
 * Gate "weekly" is registered in getSolPayKit() pricing catalogue.
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
    "weekly",
    async (_req: Request, payment: { payer: string }) => {
      return Response.json({
        content: "Subscription verified — weekly access granted",
        paidBy: payment.payer,
        planId: "bluvfi-weekly-v1",
        priceUSDC: "0.25",
        period: "1 week",
      });
    },
  );

  return handler(req);
}
