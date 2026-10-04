import { NextResponse } from "next/server";
import { listSecurities, stockPrices, currentSession, listStockSpotMarkets, spotSymbol } from "@/lib/backpack";
import { stocksErrorResponse } from "@/lib/stocks-http";

/**
 * GET /api/stocks/list?q=apple&limit=50
 * Tradable US stocks & ETFs with live prices, most-traded first, plus whether
 * the market is open. Public data.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = params.get("q")?.trim().toLowerCase() ?? "";
  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 200);
  try {
    const [securities, prices, session, spot] = await Promise.all([listSecurities(), stockPrices(), currentSession(), listStockSpotMarkets()]);
    const spotSet = new Set(spot);
    const rows = securities
      .filter((s) => !q || s.asset.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .map((s) => {
        const t = prices.get(s.asset);
        return {
          asset: s.asset,
          ticker: s.asset.replace(/\.US$/, ""),
          name: s.name,
          price: t ? Number(t.lastPrice) : null,
          changePct: t ? Number(t.priceChangePercent) * 100 : null,
          volumeUsd: t ? Number(t.quoteVolume) : 0,
          tradableNow: session ? s.sessions.some((x) => x.name === session.name) : spotSet.has(spotSymbol(s.asset)),
        };
      })
      .sort((a, b) => {
        // Exact ticker match first when searching, then most traded.
        if (q) {
          const ea = a.ticker.toLowerCase() === q ? 1 : 0;
          const eb = b.ticker.toLowerCase() === q ? 1 : 0;
          if (ea !== eb) return eb - ea;
        }
        return b.volumeUsd - a.volumeUsd;
      })
      .slice(0, limit);
    return NextResponse.json(
      { session: session ? { name: session.name, description: session.description } : null, total: securities.length, stocks: rows },
      { headers: { "Cache-Control": "public, max-age=15" } },
    );
  } catch (err) {
    return stocksErrorResponse(err, "list");
  }
}
