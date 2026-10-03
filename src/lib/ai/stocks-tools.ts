import { tool } from "ai";
import { z } from "zod";
import {
  listSecurities,
  stockPrices,
  stockKlines,
  currentSession,
  listStockSpotMarkets,
  spotSymbol,
  backpackConfigured,
} from "@/lib/backpack";
import { quoteTrade, listOrders, requestWithdrawal, StocksError } from "@/lib/stocks";
import { holdings, CASH } from "@/lib/stocks-ledger";

/**
 * AI agent tools for US stocks & ETFs on Backpack — the same data and trading
 * as Invest → Market → Backpack.
 *
 *   search_stocks        tickers with live prices + whether the market is open
 *   get_stock            one stock: price, day range, 1-month move, trade sizes
 *   get_stock_portfolio  the user's holdings, credit and recent orders
 *   trade_stock          prices a buy/sell and shows a confirm card in chat; the
 *                        card pays from the wallet and places it. Nothing is
 *                        bought, sold or charged until the user confirms there.
 */

// Same split as the app's Stocks / ETFs tabs.
const ETF_RE = /\bETF\b|\bTrust\b|\bFund\b|iShares|SPDR|Vanguard|ProShares|Invesco|Direxion/i;

const tickerSchema = z.string().min(1).max(12).describe("Ticker, e.g. 'AAPL', 'NVDA', 'SPY' (no .US suffix needed)");
const toAsset = (t: string) => `${t.toUpperCase().replace(/\.US$/, "")}.US`;
const sessionLabel = (name?: string | null) =>
  name ? name.replace("US_EQUITIES_", "").replace("_", "-").toLowerCase() : "closed";

function errorResult(err: unknown) {
  if (err instanceof StocksError) return { error: err.message };
  return { error: "Stock data is temporarily unavailable. Try again shortly." };
}

export function createStocksTools(userId?: string) {
  return {
    search_stocks: tool({
      description:
        "Search US stocks and ETFs tradable in Bluvfi (via Backpack Exchange) with live prices. Also says whether the US market " +
        "is open right now and which session (pre-market, regular, post-market, overnight). With no query, returns the most-traded.",
      inputSchema: z.object({
        query: z.string().max(40).optional().describe("Ticker or company name, e.g. 'tesla', 'NVDA', 'S&P 500'"),
        kind: z.enum(["stock", "etf", "all"]).optional().describe("Filter to stocks or ETFs (default all)"),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async ({ query, kind = "all", limit = 10 }) => {
        try {
          const q = query?.trim().toLowerCase() ?? "";
          const [securities, prices, session, spot] = await Promise.all([listSecurities(), stockPrices(), currentSession(), listStockSpotMarkets()]);
          const spotSet = new Set(spot);
          const rows = securities
            .filter((s) => !q || s.asset.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
            .filter((s) => kind === "all" || (kind === "etf") === ETF_RE.test(s.name))
            .map((s) => {
              const t = prices.get(s.asset);
              const ticker = s.asset.replace(/\.US$/, "");
              return {
                ticker,
                name: s.name,
                price: t ? Number(t.lastPrice) : null,
                changePctToday: t ? Number((Number(t.priceChangePercent) * 100).toFixed(2)) : null,
                volumeUsd: t ? Math.round(Number(t.quoteVolume)) : 0,
                tradableNow: session ? s.sessions.some((x) => x.name === session.name) : spotSet.has(spotSymbol(s.asset)),
                exact: ticker.toLowerCase() === q,
              };
            })
            .sort((a, b) => Number(b.exact) - Number(a.exact) || b.volumeUsd - a.volumeUsd)
            .slice(0, limit)
            .map(({ exact: _exact, ...r }) => r);
          return {
            market: session ? `open (${sessionLabel(session.name)})` : "closed",
            tradingEnabled: backpackConfigured(),
            results: rows,
            tip: rows.length ? "Prices are live USD. Call trade_stock to buy or sell." : "No match. Try the company name or a different ticker.",
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    }),

    get_stock: tool({
      description: "Details for one US stock/ETF on Backpack: live price, today's range and change, 1-month move, and allowed trade sizes right now.",
      inputSchema: z.object({ ticker: tickerSchema }),
      execute: async ({ ticker }) => {
        try {
          const asset = toAsset(ticker);
          const sec = (await listSecurities()).find((s) => s.asset === asset);
          if (!sec) return { error: `${ticker.toUpperCase()} isn't available. Use search_stocks to find the right ticker.` };
          const [prices, session, klines] = await Promise.all([stockPrices(), currentSession(), stockKlines(asset, "1d", 31).catch(() => [])]);
          const t = prices.get(asset);
          const closes = klines.map((k) => Number(k.close)).filter((n) => n > 0);
          const rules = session ? sec.sessions.find((s) => s.name === session.name) : undefined;
          return {
            ticker: asset.replace(/\.US$/, ""),
            name: sec.name,
            price: t ? Number(t.lastPrice) : null,
            changePctToday: t ? Number((Number(t.priceChangePercent) * 100).toFixed(2)) : null,
            dayLow: t ? Number(t.low) : null,
            dayHigh: t ? Number(t.high) : null,
            changePct1Month: closes.length > 1 ? Number((((closes[closes.length - 1] - closes[0]) / closes[0]) * 100).toFixed(2)) : null,
            market: session ? `open (${sessionLabel(session.name)})` : "closed",
            tradeSizeNow: rules ? { minShares: rules.minQuantity, maxShares: rules.maxQuantity, step: rules.stepSize } : null,
            source: "Backpack Exchange (fair-market price feed)",
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    }),

    get_stock_portfolio: tool({
      description: "The user's stock & ETF holdings on Bluvfi (valued live), any leftover credit, and their recent stock orders.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!userId) return { error: "Not authenticated" };
        try {
          const [rows, prices, orders] = await Promise.all([holdings(userId), stockPrices(), listOrders(userId, 10)]);
          const credit = Number(rows.find((r) => r.asset === CASH)?.amount ?? 0);
          const positions = rows.filter((r) => r.asset !== CASH).map((r) => {
            const price = Number(prices.get(r.asset)?.lastPrice ?? 0);
            return {
              ticker: r.asset.replace(/\.US$/, ""),
              shares: Number(r.amount),
              price,
              valueUsd: Number((Number(r.amount) * price).toFixed(2)),
              changePctToday: Number((Number(prices.get(r.asset)?.priceChangePercent ?? 0) * 100).toFixed(2)),
            };
          });
          return {
            totalUsd: Number((credit + positions.reduce((s, p) => s + p.valueUsd, 0)).toFixed(2)),
            creditUsd: Number(credit.toFixed(2)),
            positions,
            recentOrders: orders.map((o) => ({
              ticker: o.asset.replace(/\.US$/, ""),
              side: o.side,
              shares: Number(o.fillQuantity ?? o.quantity),
              status: o.status,
              fillPrice: o.fillPrice ? Number(o.fillPrice) : null,
              at: o.createdAt,
            })),
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    }),

    withdraw_stock_credit: tool({
      description:
        "Send the user's leftover stock credit (unused buy money, or sale money under $1) back to their Bluvfi wallet as USDC on Base. " +
        "Minimum $1. Only call after the user asked to withdraw it and confirmed the amount (check get_stock_portfolio for creditUsd).",
      inputSchema: z.object({
        amountUsd: z.number().positive().optional().describe("Dollars to send; omit with all=true to send everything"),
        all: z.boolean().optional(),
      }),
      execute: async ({ amountUsd, all }) => {
        if (!backpackConfigured()) return { error: "Stock trading isn't switched on yet." };
        if (!userId) return { error: "Not authenticated" };
        try {
          const credit = Number((await holdings(userId)).find((h) => h.asset === CASH)?.amount ?? 0);
          const amount = all ? Math.floor(credit * 100) / 100 : amountUsd ?? 0;
          if (!(amount >= 1)) return { error: credit < 1 ? `Credit is $${credit.toFixed(2)} — below the $1 minimum; it's used on the next buy instead.` : "Ask how much to send (or all)." };
          if (amount > credit + 1e-9) return { error: `They only have $${credit.toFixed(2)} of credit.` };
          const r = await requestWithdrawal(userId, amount.toFixed(2));
          return {
            sent: r.status === "sent",
            queued: r.status === "queued",
            amountUsd: Number(r.amount),
            to: r.to,
            tip: r.status === "sent" ? "Tell the user it's on its way to their wallet (usually minutes)." : "Tell the user the withdrawal is requested and usually arrives within 24 hours.",
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    }),

    trade_stock: tool({
      description:
        "Buy or sell a US stock/ETF on Backpack. Prices the trade and shows the user a confirm card; the card pays with USDC from their " +
        "wallet (no gas) for a buy, places the order at a capped price, and shows the result. Sale money goes back to their wallet. " +
        "Buys are in dollars (amountUsd), sells in shares (shares, or all=true). Only call after the user clearly asked to trade.",
      inputSchema: z.object({
        ticker: tickerSchema,
        side: z.enum(["buy", "sell"]),
        amountUsd: z.number().positive().optional().describe("Buy only: how many dollars to invest, e.g. 50"),
        shares: z.number().positive().optional().describe("Sell (or buy by shares): number of shares, fractions allowed"),
        all: z.boolean().optional().describe("Sell only: sell every share the user holds"),
      }),
      execute: async ({ ticker, side, amountUsd, shares, all }) => {
        if (!backpackConfigured()) return { error: "Stock trading isn't switched on yet. Prices and charts are available." };
        if (!userId) return { error: "Not authenticated" };
        try {
          const asset = toAsset(ticker);
          let qty: number;
          if (side === "sell") {
            const owned = Number((await holdings(userId)).find((h) => h.asset === asset)?.amount ?? 0);
            if (!(owned > 0)) return { error: `The user doesn't own any ${asset.replace(/\.US$/, "")}.` };
            qty = all ? owned : shares ?? 0;
            if (!(qty > 0)) return { error: "Ask how many shares to sell (or whether to sell all)." };
            if (qty > owned) return { error: `They only own ${owned} shares.` };
          } else if (amountUsd !== undefined) {
            const price = Number((await stockPrices()).get(asset)?.lastPrice ?? 0);
            if (!(price > 0)) return { error: `No live price for ${ticker.toUpperCase()} right now.` };
            qty = amountUsd / price;
          } else if (shares !== undefined) {
            qty = shares;
          } else {
            return { error: "Ask how much (in dollars) the user wants to invest." };
          }
          // Validates market hours, size limits and prices it — nothing is reserved or sent.
          const quote = await quoteTrade(asset, side, qty.toFixed(6));
          return {
            pendingStockTrade: true,
            ticker: asset.replace(/\.US$/, ""),
            name: quote.name,
            side,
            quote,
            tip:
              'CONFIRM CARD SHOWN. Output only: "Here\'s your order — tap Confirm to place it." Then STOP. ' +
              "The card pays, places the order and shows the result. When it reports {done:true}, summarize what filled. " +
              "If it reports {done:false}, relay the error plainly.",
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    }),
  };
}
