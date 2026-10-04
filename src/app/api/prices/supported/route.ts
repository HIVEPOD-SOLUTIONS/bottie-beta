import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { cmcGetCached, PriceFeedNotConfiguredError } from "@/lib/coinmarketcap";
import { parseCoins, pickBestPerSymbol } from "@/lib/coinmarketcap-parse";
import { getSupportedCoins } from "@/lib/supported-coins";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * GET /api/prices/supported
 *
 * Live prices for every crypto token any Bluvfi provider supports, each tagged with the providers that
 * support it. Authenticated and server-side like /api/prices; the symbol list is built on the server
 * (lib/supported-coins.ts), so a caller can't spend CoinMarketCap credits on arbitrary lookups.
 */

type Row = {
  id: number | null;
  symbol: string;
  name: string;
  rank: number | null;
  priceUsd: number;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  marketCap: number | null;
  providers: string[];
};
type Snapshot = { coins: Row[]; fetchedAt: number };

let lastGood: Snapshot | null = null;

export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  const limit = await checkApiLimit(userId, "prices-supported", 30, 1500);
  if (!limit.allowed) {
    return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  }

  try {
    const supported = await getSupportedCoins();
    const symbols = supported.map((c) => c.symbol);
    const { body, fetchedAt } = await cmcGetCached("/v3/cryptocurrency/quotes/latest", {
      symbol: symbols.join(","),
      convert: "USD",
      skip_invalid: "true",
    });
    // The quotes endpoint returns every look-alike coin per ticker; keep the best-ranked one.
    const quotes = pickBestPerSymbol(parseCoins(body, "USD"), symbols);
    const providersOf = new Map(supported.map((c) => [c.symbol, c.providers]));
    const coins: Row[] = quotes
      .filter((q) => providersOf.has(q.symbol.toUpperCase()))
      .map((q) => ({
        id: q.id,
        symbol: q.symbol.toUpperCase(),
        name: q.name,
        rank: q.rank,
        priceUsd: q.price,
        change1h: q.change1h,
        change24h: q.change24h,
        change7d: q.change7d,
        marketCap: q.marketCap,
        providers: providersOf.get(q.symbol.toUpperCase()) ?? [],
      }))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));

    if (coins.length === 0) throw new Error("CoinMarketCap returned no prices for the supported coins");
    lastGood = { coins, fetchedAt };
    return NextResponse.json({ ...lastGood, stale: false }, { headers: { "Cache-Control": "private, max-age=15" } });
  } catch (err) {
    if (err instanceof PriceFeedNotConfiguredError) {
      return NextResponse.json({ error: "Price feed not configured" }, { status: 501 });
    }
    if (lastGood) return NextResponse.json({ ...lastGood, stale: true });
    console.error("[prices/supported]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Prices are temporarily unavailable" }, { status: 502 });
  }
}
