import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { depositInstructions, verifyDeposit } from "@/lib/stocks";
import { requireTrading, stocksErrorResponse } from "@/lib/stocks-http";

/**
 * GET  /api/stocks/deposit            → where to send USDC (Base) to fund stock cash
 * POST /api/stocks/deposit { txHash } → verify that transfer on-chain and credit it (once)
 */
export async function GET() {
  try {
    await verifyAuth();
  } catch (err) {
    return authErrorResponse(err);
  }
  const blocked = requireTrading();
  if (blocked) return blocked;
  try {
    return NextResponse.json(await depositInstructions());
  } catch (err) {
    return stocksErrorResponse(err, "deposit");
  }
}

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const blocked = requireTrading();
  if (blocked) return blocked;
  let txHash: string | undefined;
  try {
    ({ txHash } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!txHash) return NextResponse.json({ error: "txHash is required" }, { status: 400 });
  try {
    return NextResponse.json(await verifyDeposit(userId, txHash));
  } catch (err) {
    return stocksErrorResponse(err, "deposit");
  }
}
