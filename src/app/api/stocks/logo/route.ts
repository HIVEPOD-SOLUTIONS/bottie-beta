import { NextResponse } from "next/server";
import { cmcRequest } from "@/lib/coinmarketcap";

/**
 * GET /api/stocks/logo?ticker=TSLG — redirects to the CoinMarketCap logo for a
 * Backpack stock/ETF, or 404s if CMC has none.
 *
 * Last resort in StockLogo (stocks-section.tsx): the app tries two keyless logo
 * CDNs first, so this is only hit for the handful of tickers they miss (mostly
 * niche leveraged/inverse ETFs). One CMC credit per ticker per day; results,
 * including "no logo", are cached in memory.
 */

const TTL_MS = 24 * 60 * 60_000;
const cache = new Map<string, { at: number; url: string | null }>();

type RwaInfo = { symbol?: string; logo?: string; about?: { logo?: string } };

async function lookup(ticker: string): Promise<string | null> {
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.url;
  let url: string | null = null;
  try {
    const body = (await cmcRequest("/v5/real-world-assets/info", { symbol: ticker, skip_invalid: "true" })) as {
      data?: RwaInfo[] | Record<string, RwaInfo | RwaInfo[]>;
    };
    const rows = Array.isArray(body.data) ? body.data : Object.values(body.data ?? {}).flat();
    const row = rows.find((r) => r.symbol === ticker);
    const logo = row?.about?.logo ?? row?.logo;
    url = logo?.startsWith("https://") ? logo : null;
  } catch {
    // No CMC key, rate limit, unknown symbol… just no logo. Don't cache errors.
    return null;
  }
  cache.set(ticker, { at: Date.now(), url });
  if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
  return url;
}

export async function GET(req: Request) {
  const ticker = new URL(req.url).searchParams.get("ticker")?.toUpperCase() ?? "";
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) return new NextResponse(null, { status: 400 });
  const url = await lookup(ticker);
  if (!url) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "public, max-age=86400" } });
  return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "public, max-age=86400" } });
}
