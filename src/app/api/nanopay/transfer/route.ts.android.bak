import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { getBuyerClient } from "@/lib/circle-gateway";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { amount, recipient, chain } = await req.json().catch(() => ({}));
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  if (!recipient || typeof recipient !== "string")
    return NextResponse.json({ error: "recipient address is required" }, { status: 400 });

  try {
    const client = getBuyerClient();
    const result = await client.transfer(String(amount), chain ?? "base", recipient as `0x${string}`);

    // Persist to DB
    db.insert(payments).values({
      userId,
      type: "transfer",
      referenceId: result.mintTxHash ?? null,
      description: `Circle Gateway transfer: ${result.formattedAmount} USDC → ${recipient} (${chain ?? "base"})`,
      amountUsdc: String(Number(amount)),
      status: "completed",
      txHash: result.mintTxHash ?? null,
      chain: "evm",
    }).catch(() => {});

    return NextResponse.json({
      txHash: result.mintTxHash,
      amount: result.formattedAmount,
      recipient,
      chain: result.destinationChain ?? chain ?? "base",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Transfer failed" }, { status: 500 });
  }
}
