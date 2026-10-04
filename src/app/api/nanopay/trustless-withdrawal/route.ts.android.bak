/**
 * Trustless withdrawal — censorship-resistant exit from Circle Gateway.
 * Does NOT require the Circle facilitator to be online or cooperative.
 * Two-phase process:
 *   POST { action: "initiate", amount: string } — locks funds, starts delay
 *   POST { action: "complete" }                 — claims after delay passes
 *   GET                                         — query current withdrawal state
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { getBuyerClient } from "@/lib/circle-gateway";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

export async function GET() {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  try {
    const client = getBuyerClient();
    const [delay, block, balance] = await Promise.all([
      client.getTrustlessWithdrawalDelay(),
      client.getTrustlessWithdrawalBlock(),
      client.getBalance(),
    ]);
    return NextResponse.json({
      delayBlocks: delay.toString(),
      withdrawalAvailableAtBlock: block.toString(),
      withdrawableUsdc: balance.formattedWithdrawable ?? null,
      availableUsdc: balance.formattedAvailable ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to fetch withdrawal state" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let userId: string;
  try { ({ userId } = await verifyAuth()); } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { action, amount } = await req.json().catch(() => ({}));
  if (action !== "initiate" && action !== "complete")
    return NextResponse.json({ error: "action must be 'initiate' or 'complete'" }, { status: 400 });

  try {
    const client = getBuyerClient();
    if (action === "initiate") {
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
        return NextResponse.json({ error: "amount is required for initiate" }, { status: 400 });
      const result = await client.initiateTrustlessWithdrawal(String(amount));

      // Record pending trustless withdrawal
      db.insert(payments).values({
        userId,
        type: "withdrawal",
        referenceId: result.txHash ?? null,
        description: `Circle trustless withdrawal initiated: ${result.formattedAmount} USDC`,
        amountUsdc: String(Number(amount)),
        status: "pending",
        txHash: result.txHash ?? null,
        chain: "evm",
      }).catch(() => {});

      return NextResponse.json({
        action: "initiated",
        txHash: result.txHash,
        amount: result.formattedAmount,
        withdrawalAvailableAtBlock: result.withdrawalBlock?.toString() ?? null,
        note: "Call complete once the current block exceeds withdrawalAvailableAtBlock (check GET for status)",
      });
    } else {
      const result = await client.completeTrustlessWithdrawal();

      // Update pending row to completed (match by txHash if we have it, else insert new)
      if (result.txHash) {
        db.insert(payments).values({
          userId,
          type: "withdrawal",
          referenceId: result.txHash,
          description: `Circle trustless withdrawal completed: ${result.formattedAmount} USDC`,
          amountUsdc: result.formattedAmount ?? "0",
          status: "completed",
          txHash: result.txHash,
          chain: "evm",
        }).onConflictDoNothing().catch(() => {});
      }

      return NextResponse.json({
        action: "completed",
        txHash: result.txHash,
        amount: result.formattedAmount,
      });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Trustless withdrawal failed" }, { status: 500 });
  }
}
