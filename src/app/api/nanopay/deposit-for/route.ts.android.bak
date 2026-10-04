/**
 * POST /api/nanopay/deposit-for
 * Deposit USDC from the agent wallet into another address's Circle Gateway balance.
 * Useful for funding a user's or another agent's gateway so they can make gas-free payments.
 *
 * Body: { amount: string, depositor: `0x${string}` }
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { getBuyerClient } from "@/lib/circle-gateway";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

export async function POST(req: Request) {
  let userId: string;
  try { ({ userId } = await verifyAuth()); } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { amount, depositor } = await req.json().catch(() => ({}));
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  if (!depositor || typeof depositor !== "string")
    return NextResponse.json({ error: "depositor address is required" }, { status: 400 });

  try {
    const client = getBuyerClient();
    const result = await client.depositFor(String(amount), depositor as `0x${string}`);

    // Record the deposit-for in the payments ledger
    db.insert(payments).values({
      userId,
      type: "deposit",
      referenceId: result.depositTxHash ?? null,
      description: `Circle Gateway depositFor: ${result.formattedAmount} USDC → ${depositor}`,
      amountUsdc: String(Number(amount)),
      status: "completed",
      txHash: result.depositTxHash ?? null,
      chain: "evm",
    }).catch(() => {});

    return NextResponse.json({
      ...(result.approvalTxHash ? { approvalTxHash: result.approvalTxHash } : {}),
      depositTxHash: result.depositTxHash,
      amount: result.formattedAmount,
      depositor,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "depositFor failed" }, { status: 500 });
  }
}
