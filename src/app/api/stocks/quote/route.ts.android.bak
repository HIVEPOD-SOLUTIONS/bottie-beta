import { NextResponse } from "next/server";
import { quoteTrade } from "@/lib/stocks";
import { stocksErrorResponse } from "@/lib/stocks-http";

/** GET /api/stocks/quote?asset=AAPL.US&side=buy&quantity=0.5 — validates and prices a trade; reserves nothing. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const asset = params.get("asset") ?? "";
  const side = params.get("side");
  const quantity = params.get("quantity") ?? "";
  if (!asset || (side !== "buy" && side !== "sell") || !quantity) {
    return NextResponse.json({ error: "asset, side (buy|sell) and quantity are required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ quote: await quoteTrade(asset, side, quantity) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return stocksErrorResponse(err, "quote");
  }
}
