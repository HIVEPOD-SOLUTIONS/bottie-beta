/**
 * Solana x402 usage gate — metered billing up to $0.10 USDC.
 *
 * POST /api/solpay/sell-usage  { text: "..." }
 *   • Unpaid: 402 + x402 challenge (usage gates force x402 per MPP spec)
 *   • Paid: processes text, records actual word count via Charge, settles only what was consumed
 *
 * Pricing: $0.001 USDC per word (1000 base units/word), ceiling $0.10.
 * Gate "metered" is registered in getSolPayKit() pricing catalogue.
 */

import { getSolPayKit } from "@/lib/solana-pay-kit";

const BASE_UNITS_PER_WORD = 1000n; // 0.001 USDC per word (1 USDC = 1_000_000 base units)

export async function POST(req: Request) {
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
    "metered",
    async (request: Request, payment: { payer: string }) => {
      // charge() returns the Charge object — call charge.charge(n) to record actual base units consumed
      // The SDK settles exactly that amount; the client is never overcharged
      const charge = paykit.charge(request);

      const body = await request.json().catch(() => ({})) as { text?: string };
      const text = (body.text ?? "Hello from Bluvfi!").trim();
      const words = text.split(/\s+/).filter(Boolean).length;

      charge?.charge(BigInt(words) * BASE_UNITS_PER_WORD);

      return Response.json({
        result: text.toUpperCase(),
        paidBy: payment.payer,
        words,
        chargedUSDC: (words * 0.001).toFixed(6),
        maxUSDC: "0.10",
      });
    },
  );

  return handler(req);
}
