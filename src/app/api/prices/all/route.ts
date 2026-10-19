import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { cmcGetCached, describeCmcError, PriceFeedNotConfiguredError } from "@/lib/coinmarketcap";
import { parseCoins, pickBestPerSymbol, type CoinQuote } from "@/lib/coinmarketcap-parse";
import { getSupportedCoins } from "@/lib/supported-coins";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * GET /api/prices/all?start=1&limit=100       — every coin CoinMarketCap lists, by market cap, a page at a time
 * GET /api/prices/all?symbol=PEPE             — look one ticker up directly (best-ranked coin with that symbol)
 *
 * Authenticated and cached like /api/prices (cmcGetCached: one upstream call serves everyone for the TTL).
 * Coins that a Bluvfi provider supports also carry `providers`, so the app can badge them.
 */

const PAGE_MAX = 200;
/** Only the top 5,000 coins are pageable, which bounds how many distinct CMC pages (credits) one account can pull. */
const START_MAX = 5_000;

/** Providers keyed by the canonical coin's CMC id, so a look-alike sharing a ticker never gets a real coin's badge. */
async function providersById(): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  try {
    const supported = await getSupportedCoins();
    const symbols = supported.map((c) => c.symbol);
    const { body } = await cmcGetCached("/v3/cryptocurrency/quotes/latest", { symbol: symbols.join(","), convert: "USD", skip_invalid: "true" });
    const bySymbol = new Map(supported.map((c) => [c.symbol, c.providers]));
    for (const c of pickBestPerSymbol(parseCoins(body, "USD"), symbols)) {
      if (c.id !== null) out.set(c.id, bySymbol.get(c.symbol.toUpperCase()) ?? []);
    }
  } catch { /* badges are optional */ }
  return out;
}

function row(c: CoinQuote, providers: Map<number, string[]>) {
  return {
    // Tickers aren't unique on CMC (look-alikes share them); the id is what keys a row.
    id: c.id ?? `${c.symbol}-${c.rank ?? c.name}`,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    rank: c.rank,
    priceUsd: c.price,
    change1h: c.change1h,
    change24h: c.change24h,
    change7d: c.change7d,
    marketCap: c.marketCap,
    providers: (c.id !== null && providers.get(c.id)) || [],
  };
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  // Each new page costs CoinMarketCap credits, so cap it per user as well as per IP (the screen loads a page per scroll).
  const limit_ = await checkApiLimit(userId, "prices-all", 60, 3000);
  if (!limit_.allowed) {
    return NextResponse.json({ error: limit_.reason }, { status: 429, headers: limit_.headers });
  }

  const sp = req.nextUrl.searchParams;
  const symbol = sp.get("symbol")?.trim().toUpperCase();
  const start = Math.max(1, Math.min(START_MAX, Math.floor(Number(sp.get("start")) || 1)));
  const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(Number(sp.get("limit")) || 100)));

  if (symbol && !/^[A-Z0-9]{1,12}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  try {
    const providers = await providersById();

    if (symbol) {
      const { body, fetchedAt } = await cmcGetCached("/v3/cryptocurrency/quotes/latest", {
        symbol,
        convert: "USD",
        skip_invalid: "true",
      });
      const coins = pickBestPerSymbol(parseCoins(body, "USD"), [symbol]).map((c) => row(c, providers));
      return NextResponse.json({ coins, nextStart: null, fetchedAt });
    }

    const { body, fetchedAt } = await cmcGetCached("/v3/cryptocurrency/listings/latest", {
      start,
      limit,
      sort: "market_cap",
      sort_dir: "desc",
      convert: "USD",
    });
    const coins = parseCoins(body, "USD").map((c) => row(c, providers));
    return NextResponse.json(
      { coins, nextStart: coins.length >= limit ? start + limit : null, fetchedAt },
      { headers: { "Cache-Control": "private, max-age=15" } },
    );
  } catch (err) {
    if (err instanceof PriceFeedNotConfiguredError) {
      return NextResponse.json({ error: "Price feed not configured" }, { status: 501 });
    }
    console.error("[prices/all]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeCmcError(err) }, { status: 502 });
  }
}
