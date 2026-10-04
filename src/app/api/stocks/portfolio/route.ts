import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { holdings, CASH } from "@/lib/stocks-ledger";
import { listOrders } from "@/lib/stocks";
import { stockPrices, listSecurities, backpackConfigured } from "@/lib/backpack";
import { stocksErrorResponse } from "@/lib/stocks-http";

/** GET /api/stocks/portfolio — the user's stock cash, positions (valued live) and recent orders. */
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  try {
    const [rows, prices, securities, orders] = await Promise.all([holdings(userId), stockPrices(), listSecurities(), listOrders(userId, 20)]);
    const names = new Map(securities.map((s) => [s.asset, s.name]));
    const cash = Number(rows.find((r) => r.asset === CASH)?.amount ?? 0);
    const positions = rows.filter((r) => r.asset !== CASH).map((r) => {
      const t = prices.get(r.asset);
      const price = Number(t?.lastPrice ?? 0);
      return {
        asset: r.asset,
        ticker: r.asset.replace(/\.US$/, ""),
        name: names.get(r.asset) ?? r.asset,
        quantity: r.amount,
        price,
        valueUsd: Number(r.amount) * price,
        changePct: Number(t?.priceChangePercent ?? 0) * 100,
      };
    });
    return NextResponse.json({
      tradingEnabled: backpackConfigured(),
      cashUsd: cash,
      positions,
      totalUsd: cash + positions.reduce((s, p) => s + p.valueUsd, 0),
      orders: orders.map((o) => ({
        id: o.id,
        asset: o.asset,
        side: o.side,
        quantity: o.quantity,
        status: o.status,
        fillPrice: o.fillPrice,
        fillQuantity: o.fillQuantity,
        error: o.status === "failed" ? o.error : null,
        createdAt: o.createdAt,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return stocksErrorResponse(err, "portfolio");
  }
}
