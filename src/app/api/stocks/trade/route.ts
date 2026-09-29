import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { placeTrade } from "@/lib/stocks";
import { requireTrading, stocksErrorResponse } from "@/lib/stocks-http";

/**
 * POST /api/stocks/trade { asset, side: "buy"|"sell", quantity, limitPrice }
 * `limitPrice` is the price cap the user saw on the quote; the trade is
 * refused if the fresh cap is worse. Returns the order (usually still
 * pending — poll /api/stocks/orders/[id] until filled).
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const blocked = requireTrading();
  if (blocked) return blocked;

  let body: { asset?: string; side?: string; quantity?: string | number; limitPrice?: string | number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { asset, side } = body;
  const quantity = String(body.quantity ?? "");
  if (!asset || (side !== "buy" && side !== "sell") || !/^\d+(\.\d+)?$/.test(quantity)) {
    return NextResponse.json({ error: "asset, side (buy|sell) and a numeric quantity are required" }, { status: 400 });
  }
  const limitPrice = body.limitPrice === undefined ? undefined : Number(body.limitPrice);
  try {
    const order = await placeTrade(userId, asset, side, quantity, Number.isFinite(limitPrice) ? limitPrice : undefined);
    return NextResponse.json({ order });
  } catch (err) {
    return stocksErrorResponse(err, "trade");
  }
}
