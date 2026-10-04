/**
 * Settles a completed on-chain transfer's receipt via Circle Gateway x402
 * nanopayments — called by the UI right after a bill/investment payment's
 * arcKit.send() confirms, so every checkout also exercises the real x402
 * pay-and-settle round trip against /api/nanopay/sell.
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.CIRCLE_BUYER_PRIVATE_KEY) {
    return NextResponse.json({ usedNanopay: false, simulated: true });
  }

  try {
    const { getBuyerClient } = await import("@/lib/circle-gateway");
    const client = getBuyerClient();
    const base = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
    const resourceUrl = `${base}/api/nanopay/sell`;

    const support = await client.supports(resourceUrl);
    if (!support.supported) {
      return NextResponse.json({ usedNanopay: false, simulated: true });
    }

    const result = await client.pay(resourceUrl);

    // Record the checkout nanopayment in the DB
    const paidUsdc = result?.amount != null ? Number(result.amount) / 1_000_000 : 0;
    db.insert(payments).values({
      userId,
      type: "nanopay",
      referenceId: result?.transaction ?? null,
      description: "Circle nanopay checkout: post-bill/investment settlement",
      amountUsdc: String(paidUsdc),
      status: "completed",
      txHash: result?.transaction ?? null,
      chain: "evm",
    }).catch(() => {});

    return NextResponse.json({
      usedNanopay: true,
      txHash: result?.transaction ?? null,
      paid: result?.formattedAmount ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({
      usedNanopay: false,
      simulated: true,
      error: err?.message ?? "Nanopay settlement unavailable",
    });
  }
}
