import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
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

  const { amount, recipient } = await req.json().catch(() => ({}));
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  if (!recipient || typeof recipient !== "string")
    return NextResponse.json({ error: "recipient Solana address is required" }, { status: 400 });

  try {
    const { solPayTransfer } = await import("@/lib/solana-pay-kit");
    const result = await solPayTransfer(recipient, Number(amount));

    // Persist to DB
    db.insert(payments).values({
      userId,
      type: "transfer",
      referenceId: result.txSignature,
      description: `Solana USDC transfer: ${amount} USDC → ${recipient}`,
      amountUsdc: String(Number(amount)),
      status: "completed",
      txHash: result.txSignature,
      chain: "solana",
    }).catch(() => {});

    return NextResponse.json(result);
  } catch (err: unknown) {
    return NextResponse.json(
      { error: (err as Error)?.message ?? "Transfer failed" },
      { status: 500 },
    );
  }
}
