import { NextResponse } from "next/server";
import { stockKlines } from "@/lib/backpack";
import { stocksErrorResponse } from "@/lib/stocks-http";

const RANGES = {
  "1w": { interval: "1h", days: 7 },
  "1m": { interval: "1d", days: 31 },
  "1y": { interval: "1w", days: 366 },
} as const;

/** GET /api/stocks/chart?asset=AAPL.US&range=1m — closing prices for the chart. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const asset = params.get("asset") ?? "";
  const range = (params.get("range") ?? "1m") as keyof typeof RANGES;
  if (!/^[A-Z0-9.\-]{1,20}\.US$/.test(asset) || !RANGES[range]) {
    return NextResponse.json({ error: "asset (e.g. AAPL.US) and range (1w|1m|1y) are required" }, { status: 400 });
  }
  try {
    const { interval, days } = RANGES[range];
    const k = await stockKlines(asset, interval, days);
    return NextResponse.json(
      { points: k.map((x) => ({ t: x.start, close: Number(x.close) })) },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  } catch (err) {
    return stocksErrorResponse(err, "chart");
  }
}
