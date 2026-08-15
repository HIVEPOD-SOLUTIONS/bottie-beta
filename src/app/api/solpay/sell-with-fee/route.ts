/**
 * Solana MPP charge gate with platform fee splitting.
 *
 * GET /api/solpay/sell-with-fee
 *   • Requires SOLANA_FEE_RECIPIENT env var — returns 500 if not configured.
 *   • Unpaid: 402 + MPP challenge at $0.0000011 USDC (base $0.000001 + $0.0000001 fee on top)
 *   • Paid: buyer paid $0.0000011; seller received $0.000001, fee recipient received $0.0000001
 *
 * Uses the "charge-with-fee" named gate from getSolPayKit() pricing catalogue.
 * The fee split is settled atomically on-chain — a single transaction pays both recipients.
 * feeOnTop means the fee is additive; use feeWithin to split from the base amount instead.
 *
 * Only charge (fixed) gates support fees — usage/subscription/session gates do not.
 * Fees require MPP protocol; x402 cannot express multi-recipient payments.
 */

import { getSolPayKit } from "@/lib/solana-pay-kit";

export async function GET(req: Request) {
  if (!process.env.SOLANA_FEE_RECIPIENT) {
    return Response.json(
      { error: "SOLANA_FEE_RECIPIENT not configured — set a Solana address to receive the platform fee" },
      { status: 500 },
    );
  }

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
    "charge-with-fee",
    async (_req: Request, payment: { payer: string }) => {
      return Response.json({
        content: "Payment confirmed — fee split settled on-chain",
        paidBy: payment.payer,
        breakdown: {
          total: "$0.0000011 USDC",
          seller: "$0.000001 USDC",
          platformFee: "$0.0000001 USDC",
          feeRecipient: process.env.SOLANA_FEE_RECIPIENT,
        },
      });
    },
  );

  return handler(req);
}
