import { tool } from "ai";
import { z } from "zod";
import { cmcGetCached, CmcApiError, describeCmcError } from "@/lib/coinmarketcap";
import { parseCoins, parseConversion, parseGlobalMetrics, type CoinQuote } from "@/lib/coinmarketcap-parse";

/**
 * Live market-data tools for the AI agent, backed by the CoinMarketCap Pro API.
 *
 * Five tools, one CMC endpoint each:
 *   get_crypto_prices           GET /v3/cryptocurrency/quotes/latest
 *   get_crypto_market_overview  GET /v1/global-metrics/quotes/latest + /v3/cryptocurrency/listings/latest
 *   get_top_movers              GET /v3/cryptocurrency/listings/latest   (sorted by % change)
 *   get_trending_crypto         GET /v1/cryptocurrency/trending/latest   (Startup plan and above)
 *   convert_crypto              GET /v2/tools/price-conversion
 *
 * Why these exist: the model's own knowledge of prices is stale by months, so
 * without a live source it either refuses or, worse, states an invented
 * number. Every tool returns `source` and `asOf` so the answer can say where
 * the figure came from and how fresh it is.
 *
 * Tools never throw — a failure comes back as { error } with a message that's
 * safe to relay (see describeCmcError) so the agent can explain it plainly.
 */

const SOURCE = "CoinMarketCap";
const SYMBOL = z.string().regex(/^[A-Za-z0-9]{1,12}$/, "letters/digits only, e.g. BTC");
const CURRENCY = z.string().regex(/^[A-Za-z]{2,10}$/, "a currency code such as USD, EUR, NGN or BTC");

/** Trim float noise so the model reads clean numbers (and we spend fewer tokens). */
function round(n: number | null, dp: number): number | null {
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
/** Small prices need significant digits, not decimal places (a $0.00001234 coin must not round to 0). */
function roundPrice(n: number): number {
  return n >= 1 ? round(n, 2)! : Number(n.toPrecision(4));
}

function compact(c: CoinQuote) {
  return {
    symbol: c.symbol,
    name: c.name,
    rank: c.rank,
    price: roundPrice(c.price),
    change1hPct: round(c.change1h, 2),
    change24hPct: round(c.change24h, 2),
    change7dPct: round(c.change7d, 2),
    change30dPct: round(c.change30d, 2),
    marketCap: c.marketCap === null ? null : Math.round(c.marketCap),
    volume24h: c.volume24h === null ? null : Math.round(c.volume24h),
  };
}

const fail = (err: unknown) => ({ error: describeCmcError(err) });
const asOf = (fetchedAt: number) => new Date(fetchedAt).toISOString();

export function createCmcTools() {
  return {
    get_crypto_prices: tool({
      description:
        "Get the LIVE price and market data (24h/7d/30d change, market cap, 24h volume, rank) for one or more cryptocurrencies " +
        "from CoinMarketCap. ALWAYS call this for any question about what a coin costs, is worth, or is doing — never answer a price " +
        "from memory, it is out of date. Pass ticker symbols such as BTC, ETH, SOL, XRP, DOGE (max 10). " +
        "Prices default to USD; set `convert` for another currency (e.g. NGN, EUR). " +
        "If a ticker is ambiguous CoinMarketCap picks the highest-market-cap coin with that symbol — mention this if the user might mean another. " +
        "Report the price with its `asOf` time and say it comes from CoinMarketCap.",
      inputSchema: z.object({
        symbols: z.array(SYMBOL).min(1).max(10).describe("Ticker symbols, e.g. ['BTC','ETH']"),
        convert: CURRENCY.optional().describe("Quote currency; defaults to USD"),
      }),
      execute: async ({ symbols, convert }) => {
        const currency = (convert ?? "USD").toUpperCase();
        const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
        try {
          const { body, fetchedAt } = await cmcGetCached("/v3/cryptocurrency/quotes/latest", {
            symbol: wanted.join(","),
            convert: currency,
            skip_invalid: "true",
          });
          const coins = parseCoins(body, currency);
          if (coins.length === 0) return { error: `No prices found for ${wanted.join(", ")}. Check the ticker symbols.` };
          const found = new Set(coins.map((c) => c.symbol.toUpperCase()));
          const notFound = wanted.filter((s) => !found.has(s));
          return {
            source: SOURCE, currency, asOf: asOf(fetchedAt),
            coins: coins.map(compact),
            ...(notFound.length ? { notFound } : {}),
          };
        } catch (err) {
          return fail(err);
        }
      },
    }),

    get_crypto_market_overview: tool({
      description:
        "Get a live snapshot of the overall crypto market from CoinMarketCap: total market cap, 24h volume, Bitcoin and Ethereum " +
        "dominance, and the top coins by market cap with their prices and 24h/7d change. Use for 'how is the market doing', " +
        "'what are the biggest coins', or general market-mood questions. Values are in USD. Cite CoinMarketCap and the `asOf` time.",
      inputSchema: z.object({
        topCount: z.number().int().min(1).max(25).optional().describe("How many top coins to include (default 10)"),
      }),
      execute: async ({ topCount }) => {
        const limit = topCount ?? 10;
        // Independent calls — one failing (e.g. a plan limit) shouldn't hide the other.
        const [globalRes, topRes] = await Promise.allSettled([
          cmcGetCached("/v1/global-metrics/quotes/latest", { convert: "USD" }),
          cmcGetCached("/v3/cryptocurrency/listings/latest", { limit, convert: "USD" }),
        ]);

        const global = globalRes.status === "fulfilled" ? parseGlobalMetrics(globalRes.value.body, "USD") : null;
        const top = topRes.status === "fulfilled" ? parseCoins(topRes.value.body, "USD").map(compact) : [];
        if (!global && top.length === 0) {
          const firstErr = globalRes.status === "rejected" ? globalRes.reason : topRes.status === "rejected" ? topRes.reason : null;
          return firstErr ? fail(firstErr) : { error: "Market data is temporarily unavailable." };
        }

        const fetchedAt = Math.max(
          globalRes.status === "fulfilled" ? globalRes.value.fetchedAt : 0,
          topRes.status === "fulfilled" ? topRes.value.fetchedAt : 0,
        );
        return {
          source: SOURCE, currency: "USD", asOf: asOf(fetchedAt),
          global: global && {
            totalMarketCap: global.totalMarketCap === null ? null : Math.round(global.totalMarketCap),
            totalVolume24h: global.totalVolume24h === null ? null : Math.round(global.totalVolume24h),
            btcDominancePct: round(global.btcDominance, 2),
            ethDominancePct: round(global.ethDominance, 2),
            activeCryptocurrencies: global.activeCryptocurrencies,
          },
          topByMarketCap: top,
        };
      },
    }),

    get_top_movers: tool({
      description:
        "Get the biggest crypto gainers or losers right now from CoinMarketCap, over 1 hour, 24 hours or 7 days. " +
        "Restricted to coins above a minimum market cap (default $50M) so the list isn't dominated by illiquid micro-caps — " +
        "lower `minMarketCapUsd` only if the user explicitly wants small/speculative coins. " +
        "Use for 'what's pumping', 'top gainers today', 'what's crashing'. Cite CoinMarketCap and the `asOf` time; " +
        "this is market data, not a recommendation to buy or sell.",
      inputSchema: z.object({
        direction: z.enum(["gainers", "losers"]).optional().describe("Default gainers"),
        timeframe: z.enum(["1h", "24h", "7d"]).optional().describe("Default 24h"),
        limit: z.number().int().min(1).max(15).optional().describe("Default 5"),
        minMarketCapUsd: z.number().min(0).max(1e12).optional().describe("Default 50,000,000"),
      }),
      execute: async ({ direction, timeframe, limit, minMarketCapUsd }) => {
        const dir = direction ?? "gainers";
        const tf = timeframe ?? "24h";
        try {
          const { body, fetchedAt } = await cmcGetCached("/v3/cryptocurrency/listings/latest", {
            limit: limit ?? 5,
            sort: `percent_change_${tf}`,
            sort_dir: dir === "gainers" ? "desc" : "asc",
            market_cap_min: minMarketCapUsd ?? 50_000_000,
            convert: "USD",
          });
          const coins = parseCoins(body, "USD").map(compact);
          if (coins.length === 0) return { error: "No coins matched. Try lowering the minimum market cap." };
          return { source: SOURCE, currency: "USD", asOf: asOf(fetchedAt), direction: dir, timeframe: tf, movers: coins };
        } catch (err) {
          return fail(err);
        }
      },
    }),

    get_trending_crypto: tool({
      description:
        "Get the cryptocurrencies currently TRENDING on CoinMarketCap (ranked by search/attention) over 24h, 7d or 30d. " +
        "Use for 'what's trending' / 'what is everyone looking at'. Different from get_top_movers, which ranks by price change. " +
        "This data needs a higher CoinMarketCap plan; if it comes back unavailable, say so briefly and offer get_top_movers instead. " +
        "Cite CoinMarketCap and the `asOf` time.",
      inputSchema: z.object({
        timePeriod: z.enum(["24h", "7d", "30d"]).optional().describe("Default 24h"),
        limit: z.number().int().min(1).max(15).optional().describe("Default 5"),
      }),
      execute: async ({ timePeriod, limit }) => {
        const period = timePeriod ?? "24h";
        try {
          const { body, fetchedAt } = await cmcGetCached("/v1/cryptocurrency/trending/latest", {
            limit: limit ?? 5,
            time_period: period,
            convert: "USD",
          });
          const coins = parseCoins(body, "USD").map(compact);
          if (coins.length === 0) return { error: "No trending data came back." };
          return { source: SOURCE, currency: "USD", asOf: asOf(fetchedAt), timePeriod: period, trending: coins };
        } catch (err) {
          // Startup-plan-only endpoint: give the agent something actionable, not a bare failure.
          if (err instanceof CmcApiError && err.httpStatus === 403) {
            return { error: "Trending data isn't available on the current CoinMarketCap plan. Use get_top_movers for the biggest price movers instead." };
          }
          return fail(err);
        }
      },
    }),

    convert_crypto: tool({
      description:
        "Convert an amount of one cryptocurrency into other currencies (fiat like USD/EUR/NGN, or other crypto) at the live CoinMarketCap rate. " +
        "Use for 'how much is 250 XRP in dollars', 'what is 0.5 ETH in naira', 'how much SOL can I get for 100 USD-worth'. " +
        "To value the user's own holdings, first read the balance (e.g. get_xrp_balance) and then convert it here. " +
        "`from` is the coin being converted; `to` is up to 3 target currency codes. The result is the TOTAL value of the whole amount. " +
        "To convert fiat INTO a coin, use get_crypto_prices and divide. Cite CoinMarketCap and the `asOf` time.",
      inputSchema: z.object({
        amount: z.number().min(1e-8).max(1e12).describe("How much of `from` to convert"),
        from: SYMBOL.describe("Ticker of the coin to convert, e.g. XRP"),
        to: z.array(CURRENCY).min(1).max(3).optional().describe("Target currency codes; defaults to ['USD']"),
      }),
      execute: async ({ amount, from, to }) => {
        const targets = [...new Set((to?.length ? to : ["USD"]).map((c) => c.toUpperCase()))];
        const base = from.toUpperCase();
        try {
          const { body, fetchedAt } = await cmcGetCached("/v2/tools/price-conversion", {
            amount,
            symbol: base,
            convert: targets.join(","),
          });
          const conv = parseConversion(body, targets);
          if (!conv) return { error: `Couldn't convert ${base}. Check the ticker symbol and currency codes.` };
          return {
            source: SOURCE, asOf: asOf(fetchedAt),
            amount: conv.amount, from: conv.symbol,
            results: Object.fromEntries(
              Object.entries(conv.results).map(([cur, total]) => [cur, {
                total: total >= 1 ? round(total, 2) : Number(total.toPrecision(4)),
                ratePerUnit: roundPrice(total / conv.amount),
              }]),
            ),
          };
        } catch (err) {
          return fail(err);
        }
      },
    }),
  };
}
