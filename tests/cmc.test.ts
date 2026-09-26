/**
 * CoinMarketCap integration tests — no network, no API key.
 *
 *   npm run test:cmc
 *
 * Fixtures mirror CMC's documented response shapes, plus two behaviours we only
 * discovered by calling the real API (see the "real API" describe blocks).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseCoins,
  parseConversion,
  parseGlobalMetrics,
  parseQuotesLatest,
  pickBestPerSymbol,
  type CoinQuote,
} from "../src/lib/coinmarketcap-parse";

// ── Fixtures: shapes taken from CMC's own docs ───────────────────────────────

// v3 endpoints: `quote` is an ARRAY of { symbol: "USD", ... }
const listingsV3 = {
  data: [{
    id: 1, name: "Bitcoin", symbol: "BTC", slug: "bitcoin", cmc_rank: 1,
    quote: [{ symbol: "USD", price: 63120.95511667226, percent_change_1h: 0.615, percent_change_24h: -1.197, percent_change_7d: -0.282, percent_change_30d: -18.14, market_cap: 1265258535378.4136, volume_24h: 29127614493.57 }],
  }],
  status: { error_code: "0", error_message: "", credit_count: 1 },
};

// v1/v2 endpoints: `quote` is an OBJECT keyed by currency
const trendingV1 = {
  data: [{ id: 1, name: "Bitcoin", symbol: "BTC", cmc_rank: 5, quote: { USD: { price: 9283.92, percent_change_24h: 0.518894 } } }],
  status: { error_code: 0 },
};

// docs render /v3/cryptocurrency/quotes/latest as a BARE top-level array
const quotesBare = [{ id: 1027, name: "Ethereum", symbol: "ETH", cmc_rank: 2, quote: [{ symbol: "USD", price: 3200.5 }] }];

const conversion = { data: { symbol: "BTC", id: 1, name: "Bitcoin", amount: 50, quote: { USD: { price: 284656.08 } } }, status: {} };

describe("parsers tolerate every documented response shape", () => {
  it("v3 array-style quote", () => {
    const [c] = parseCoins(listingsV3);
    assert.equal(c.symbol, "BTC");
    assert.equal(c.price, 63120.95511667226);
    assert.equal(c.rank, 1);
    assert.equal(c.change30d, -18.14);
  });

  it("v1 object-style quote", () => {
    const [c] = parseCoins(trendingV1);
    assert.equal(c.price, 9283.92);
    assert.equal(c.change24h, 0.518894);
  });

  it("bare top-level array (the shape a naive {data} parser silently drops)", () => {
    assert.equal(parseCoins(quotesBare)[0].price, 3200.5);
  });

  it("never invents a price in another currency", () => {
    assert.equal(parseCoins(listingsV3, "EUR").length, 0);
  });

  it("price conversion: single-object data, total for `amount`", () => {
    const c = parseConversion(conversion, ["USD"]);
    assert.equal(c?.amount, 50);
    assert.equal(c?.results.USD, 284656.08);
  });

  it("conversion omits a target it has no price for, rather than faking one", () => {
    assert.equal(parseConversion(conversion, ["USD", "NGN"])?.results.NGN, undefined);
  });

  it("global metrics: totals directly on data, or nested under quote.USD", () => {
    assert.equal(parseGlobalMetrics({ data: { btc_dominance: 67, total_market_cap: 250e9 } })?.totalMarketCap, 250e9);
    assert.equal(parseGlobalMetrics({ data: { btc_dominance: 58, quote: { USD: { total_market_cap: 2.1e12 } } } })?.totalMarketCap, 2.1e12);
  });

  it("ticker parser skips a tracked coin the response omits", () => {
    const r = parseQuotesLatest(listingsV3, [{ id: 1, symbol: "BTC", name: "Bitcoin" }, { id: 52, symbol: "XRP", name: "XRP" }]);
    assert.deepEqual(r.map((x) => x.symbol), ["BTC"]);
  });

  it("garbage input never throws", () => {
    for (const bad of [null, undefined, "x", 5, {}, { data: "x" }, { data: [{ symbol: "A", quote: null }] }]) {
      assert.doesNotThrow(() => { parseCoins(bad); parseGlobalMetrics(bad); parseConversion(bad, ["USD"]); });
    }
  });
});

// ── Found by calling the real API ────────────────────────────────────────────

const coin = (over: Partial<CoinQuote>): CoinQuote => ({
  id: null, symbol: "BTC", name: "x", slug: null, rank: null, price: 1,
  change1h: null, change24h: null, change7d: null, change30d: null,
  marketCap: null, volume24h: null, lastUpdated: null, ...over,
});

describe("real API: quotes/latest returns every look-alike sharing a ticker", () => {
  it("picks the real Bitcoin over impostors that reuse the ticker BTC", () => {
    const results = pickBestPerSymbol([
      coin({ id: 38552, name: "Bitcoin Base", rank: null, price: 0 }),
      coin({ id: 1, name: "Bitcoin", rank: 1, price: 83920, marketCap: 1.6e12 }),
      coin({ id: 38692, name: "Bitcoin Second Chance", rank: 9000, price: 0 }),
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, "Bitcoin");
    assert.equal(results[0].price, 83920);
  });

  it("an unranked coin loses to any ranked one, however large its market cap", () => {
    const r = pickBestPerSymbol([coin({ name: "unranked", rank: null, marketCap: 9e15 }), coin({ name: "ranked", rank: 4000, marketCap: 1 })]);
    assert.equal(r[0].name, "ranked");
  });

  it("with equal rank, the larger market cap wins", () => {
    const r = pickBestPerSymbol([coin({ name: "small", rank: 7, marketCap: 10 }), coin({ name: "big", rank: 7, marketCap: 99 })]);
    assert.equal(r[0].name, "big");
  });

  it("returns one coin per symbol, in the order the symbols were requested", () => {
    const r = pickBestPerSymbol(
      [coin({ symbol: "XRP", rank: 5 }), coin({ symbol: "BTC", rank: 1 }), coin({ symbol: "SOL", rank: 6 }), coin({ symbol: "BTC", rank: 900 })],
      ["BTC", "SOL", "XRP"],
    );
    assert.deepEqual(r.map((c) => c.symbol), ["BTC", "SOL", "XRP"]);
  });

  it("matches symbols case-insensitively", () => {
    assert.equal(pickBestPerSymbol([coin({ symbol: "eth", rank: 2 })], ["ETH"]).length, 1);
  });
});

// ── Top-movers logic, with fetch stubbed ─────────────────────────────────────

describe("real API: market_cap_min is applied AFTER sort+limit, so movers are ranked locally", () => {
  const universe = [
    // symbol, cap, 24h change
    ["MEGA", 5e9, 2.0], ["BIG", 2e9, 9.5], ["MID", 8e8, -12.0], ["SMALL", 6e7, 31.0],
    ["TINY", 2e6, 900.0], // a micro-cap "gainer" — must never top the list
    ["FLAT", 3e8, 0.1], ["NULLCHG", 4e8, null],
  ] as const;

  let lastUrl = "";
  beforeEach(() => {
    process.env.COINMARKETCAP_API_KEY = "test-key";
    process.env.COINMARKETCAP_API_BASE = "http://cmc.test";
    globalThis.fetch = (async (url: string) => {
      lastUrl = String(url);
      return new Response(JSON.stringify({
        data: universe.map(([symbol, cap, chg], i) => ({
          id: i + 1, symbol, name: symbol, cmc_rank: i + 1,
          quote: [{ symbol: "USD", price: 1, market_cap: cap, percent_change_24h: chg }],
        })),
        status: { error_code: "0", error_message: "" },
      }), { status: 200 });
    }) as typeof fetch;
  });

  const run = async (input: object) => {
    const { createCmcTools } = await import("../src/lib/ai/cmc-tools");
    const tools = createCmcTools() as unknown as { get_top_movers: { execute: (i: object, o: object) => Promise<any> } };
    return tools.get_top_movers.execute(input, { toolCallId: "t", messages: [] });
  };

  it("asks CMC for the top coins BY MARKET CAP and never sends market_cap_min", async () => {
    await run({ timeframe: "24h", direction: "gainers" });
    assert.ok(lastUrl.includes("sort=market_cap"), lastUrl);
    assert.ok(lastUrl.includes("limit=500"), lastUrl);
    assert.ok(!lastUrl.includes("market_cap_min"), "the server-side filter is what returned zero rows");
  });

  it("gainers: default $50M floor excludes the 900% micro-cap; best is SMALL", async () => {
    const r = await run({ direction: "gainers", timeframe: "24h", limit: 3 });
    assert.deepEqual(r.movers.map((c: any) => c.symbol), ["SMALL", "BIG", "MEGA"]);
  });

  it("losers come back most-negative first", async () => {
    const r = await run({ direction: "losers", timeframe: "24h", limit: 2 });
    assert.equal(r.movers[0].symbol, "MID");
  });

  it("a coin with no % change for the timeframe is skipped, not sorted as NaN", async () => {
    const r = await run({ direction: "gainers", timeframe: "24h", limit: 15 });
    assert.ok(!r.movers.some((c: any) => c.symbol === "NULLCHG"));
  });

  it("lowering the floor is honoured", async () => {
    const r = await run({ direction: "gainers", timeframe: "24h", limit: 1, minMarketCapUsd: 1e6 });
    assert.equal(r.movers[0].symbol, "TINY");
  });

  it("says what was scanned, so the answer can be honest about it", async () => {
    const r = await run({ limit: 1 });
    assert.equal(r.source, "CoinMarketCap");
    assert.match(r.scanned, /top 500/);
  });
});
