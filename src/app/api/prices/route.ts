import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getPrices, PriceFeedNotConfiguredError } from "@/lib/coinmarketcap";

/**
 * GET /api/prices
 *
 * Live crypto prices for the dashboard ticker, proxied from CoinMarketCap so
 * the API key stays server-side and one cached upstream call serves every
 * client (see lib/coinmarketcap.ts). Authenticated so the paid feed can't be
 * scraped anonymously; the tracked coin list is fixed server-side, so a
 * caller can't use this to spend credits on arbitrary lookups.
 */
export async function GET() {
  try {
    await verifyAuth();
  } catch (err) {
    return authErrorResponse(err);
  }

  try {
    const snapshot = await getPrices();
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "private, max-age=15" } });
  } catch (err) {
    // 501 = no key in this environment. Expected in local dev / before setup,
    // and the client treats it as "hide the ticker" rather than an error.
    if (err instanceof PriceFeedNotConfiguredError) {
      return NextResponse.json({ error: "Price feed not configured" }, { status: 501 });
    }
    console.error("[prices]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Prices are temporarily unavailable" }, { status: 502 });
  }
}
