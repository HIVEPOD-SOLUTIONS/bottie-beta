import { NextResponse } from "next/server";
import { cmcRequest } from "@/lib/coinmarketcap";

/**
 * GET /api/stocks/logo?ticker=TSLG — redirects to the CoinMarketCap logo for a
 * Backpack stock/ETF, or 404s if CMC has none.
 *
 * Lookup order: CMC's real-world-asset record for the ticker, then the ticker's tokenized-stock coin
 * (xStocks "TSLAx" / Ondo "TSLAon" — CMC lists these as coins tagged "tokenized-stock", with their own logos).
 * Only tokenized-stock-tagged coins are accepted, so a crypto that merely shares the ticker never lends its logo.
 *
 * Last resort in StockLogo (stocks-section.tsx): the app tries two keyless logo
 * CDNs first, so this is only hit for the handful of tickers they miss (mostly
 * niche leveraged/inverse ETFs). One CMC credit per ticker per day; results,
 * including "no logo", are cached in memory.
 */

const TTL_MS = 24 * 60 * 60_000;
const cache = new Map<string, { at: number; url: string | null }>();

type RwaInfo = { symbol?: string; logo?: string; about?: { logo?: string } };
type CoinInfo = { symbol?: string; logo?: string; tags?: string[] | null };

/** Logo of the tokenized-stock coin for `ticker` (xStock first, then Ondo/Backed), if CMC lists one. */
async function tokenizedStockLogo(ticker: string): Promise<string | null> {
  // Try multiple naming conventions used by tokenized-stock issuers:
  //   xStocks: TSLAx   (CMC stores mixed-case; query is case-insensitive but compare must be too)
  //   Ondo:    TSLAon / TSLAON
  //   Backed:  bTSLA
  const candidates = [`${ticker}X`, `${ticker}ON`, `b${ticker}`].filter((c) => /^[A-Za-z0-9]{1,16}$/.test(c));
  if (candidates.length === 0) return null;
  const body = (await cmcRequest("/v2/cryptocurrency/info", { symbol: candidates.join(","), skip_invalid: "true" })) as {
    data?: Record<string, CoinInfo | CoinInfo[]>;
  };
  const coins = Object.values(body.data ?? {}).flat();
  // CMC stores symbols in their own casing (e.g. "TSLAx") — compare case-insensitively.
  const upperCandidates = candidates.map((c) => c.toUpperCase());
  for (const upper of upperCandidates) {
    const coin = coins.find(
      (c) => c.symbol?.toUpperCase() === upper && c.tags?.includes("tokenized-stock"),
    );
    if (coin?.logo?.startsWith("https://")) return coin.logo;
  }
  // Last resort: any coin returned that has the tokenized-stock tag, regardless of symbol.
  const any = coins.find((c) => c.tags?.includes("tokenized-stock") && c.logo?.startsWith("https://"));
  return any?.logo ?? null;
}

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
    if (!url) url = await tokenizedStockLogo(ticker);
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
