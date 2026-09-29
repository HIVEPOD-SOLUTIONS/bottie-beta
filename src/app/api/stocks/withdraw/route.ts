import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { requestWithdrawal } from "@/lib/stocks";
import { requireTrading, stocksErrorResponse } from "@/lib/stocks-http";

/** POST /api/stocks/withdraw { amount } — sends stock cash back to the user's wallet as USDC on Base. */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const blocked = requireTrading();
  if (blocked) return blocked;
  let amount: string | number | undefined;
  try {
    ({ amount } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    return NextResponse.json(await requestWithdrawal(userId, String(amount ?? "")));
  } catch (err) {
    return stocksErrorResponse(err, "withdraw");
  }
}
