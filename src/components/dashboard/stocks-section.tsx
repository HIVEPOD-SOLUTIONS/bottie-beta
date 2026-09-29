"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePrivy } from "@privy-io/react-auth";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { authFetch } from "@/lib/api-auth-fetch";

/**
 * Invest → Stocks / ETFs. US stocks and ETFs traded through Backpack Exchange
 * on Bluvfi's account; the user's holdings are tracked by /api/stocks.
 *
 * Stock cash: the user moves USDC (Base, gas sponsored) into their stock cash,
 * trades from it, and withdraws back to their wallet.
 */

type Kind = "stock" | "etf";

interface StockRow {
  asset: string;
  ticker: string;
  name: string;
  price: number | null;
  changePct: number | null;
  tradableNow: boolean;
}

interface Portfolio {
  tradingEnabled: boolean;
  cashUsd: number;
  totalUsd: number;
  positions: { asset: string; ticker: string; name: string; quantity: string; price: number; valueUsd: number; changePct: number }[];
  orders: { id: string; asset: string; side: string; quantity: string; status: string; fillPrice: string | null; fillQuantity: string | null; error: string | null; createdAt: string }[];
}

interface Quote {
  asset: string;
  name: string;
  side: "buy" | "sell";
  quantity: string;
  venue: "rfq" | "spot";
  marketPrice: number;
  limitPrice: string;
  estimateUsdc: string;
  feeUsdc: string;
}

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ETF_RE = /\bETF\b|\bTrust\b|\bFund\b|iShares|SPDR|Vanguard|ProShares|Invesco|Direxion/i;

const usd = (n: number, dp = 2) => `$${n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const pct = (n: number | null) => (n === null ? "" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

function Sheet({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[75] flex flex-col">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="flex max-h-[90vh] flex-col rounded-t-3xl bg-[#141513]">
        <div className="flex shrink-0 items-center justify-between border-b border-[#2A2B27] px-5 pb-3 pt-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#F2F0E8]">{title}</p>
            {subtitle && <p className="truncate text-xs text-[#A7A79A]">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-[#A7A79A] hover:text-white">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 pb-[calc(max(env(safe-area-inset-bottom),24px)+24px)]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Company/fund logo. Backpack's API has no logos, so try two public logo CDNs
 * (both keyless; each 404s for tickers it doesn't know) and fall back to the
 * ticker text. Class-share tickers use a dash on the CDNs (BRK.B → BRK-B).
 */
function StockLogo({ ticker, size = "h-11 w-11" }: { ticker: string; size?: string }) {
  const sym = ticker.replace(/\./g, "-");
  const sources = [
    `https://financialmodelingprep.com/image-stock/${encodeURIComponent(sym)}.png`,
    `https://assets.parqet.com/logos/symbol/${encodeURIComponent(sym)}?format=png`,
  ];
  const [i, setI] = useState(0);
  if (i >= sources.length) {
    return (
      <div className={`flex ${size} shrink-0 items-center justify-center rounded-xl bg-[#8FAE82]/15 text-[11px] font-bold text-[#8FAE82]`}>
        {ticker.slice(0, 4)}
      </div>
    );
  }
  return (
    <div className={`${size} shrink-0 overflow-hidden rounded-xl bg-white p-1.5`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={sources[i]} alt={ticker} loading="lazy" className="h-full w-full object-contain" onError={() => setI((n) => n + 1)} />
    </div>
  );
}

// ── Main section ─────────────────────────────────────────────────────────────

export function StocksSection({ kind }: { kind: Kind }) {
  const { getAccessToken, authenticated } = usePrivy();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<StockRow[]>([]);
  const [session, setSession] = useState<{ name: string; description?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [selected, setSelected] = useState<StockRow | null>(null);
  const [cashSheet, setCashSheet] = useState<"withdraw" | null>(null);

  const loadPortfolio = useCallback(() => {
    if (!authenticated) return;
    authFetch("/api/stocks/portfolio", undefined, getAccessToken)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setPortfolio(d))
      .catch(() => {});
  }, [authenticated, getAccessToken]);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/stocks/list?limit=200${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}`)
        .then(async (r) => {
          const d = await r.json();
          if (cancelled) return;
          if (!r.ok) throw new Error(d.error);
          setSession(d.session);
          setRows(d.stocks ?? []);
          setError(null);
        })
        .catch((e) => { if (!cancelled) setError(e.message || "Couldn't load stocks."); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query ? 300 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const visible = useMemo(
    () => rows.filter((r) => (kind === "etf" ? ETF_RE.test(r.name) : !ETF_RE.test(r.name))).slice(0, 60),
    [rows, kind],
  );

  const enabled = portfolio?.tradingEnabled ?? true;

  return (
    <div className="flex flex-col gap-3">
      {/* Summary + stock cash */}
      <div className="rounded-3xl bg-[#8FAE82] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[#141513]/70">{kind === "etf" ? "US ETFs" : "US Stocks"} · Backpack</p>
            <p className="mt-1 text-2xl font-bold text-[#141513]">{portfolio ? usd(portfolio.totalUsd) : "—"}</p>
            <p className="mt-0.5 text-xs text-[#141513]/60">
              {portfolio
                ? `${portfolio.positions.length} holding${portfolio.positions.length === 1 ? "" : "s"} · pay with USDC from your wallet`
                : "Sign in to trade"}
            </p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${session ? "bg-[#141513] text-[#8FAE82]" : "bg-[#141513]/20 text-[#141513]"}`}>
            {session ? `● ${session.name.replace("US_EQUITIES_", "").replace("_", "-").toLowerCase()}` : "Market closed"}
          </span>
        </div>
        {!enabled ? (
          <p className="mt-3 text-xs font-medium text-[#141513]/70">Prices are live. Trading is coming soon.</p>
        ) : portfolio && portfolio.cashUsd >= 0.01 ? (
          // Leftover credit (unused buy reserve, or sale money under $1) — used first on the next buy.
          <p className="mt-3 text-xs text-[#141513]/70">
            {usd(portfolio.cashUsd)} credit, used first on your next buy
            {portfolio.cashUsd >= 1 && (
              <> · <button onClick={() => setCashSheet("withdraw")} className="font-semibold underline">send to wallet</button></>
            )}
          </p>
        ) : null}
      </div>

      {/* Holdings */}
      {portfolio && portfolio.positions.length > 0 && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#A7A79A]">Your holdings</p>
          {portfolio.positions.map((p) => (
            <button
              key={p.asset}
              onClick={() => setSelected({ asset: p.asset, ticker: p.ticker, name: p.name, price: p.price, changePct: p.changePct, tradableNow: true })}
              className="flex w-full items-center justify-between py-1.5 text-left"
            >
              <span className="flex items-center gap-2 text-sm text-[#F2F0E8]">
                <StockLogo ticker={p.ticker} size="h-7 w-7" />
                <b>{p.ticker}</b> <span className="text-[#A7A79A]">× {Number(p.quantity)}</span>
              </span>
              <span className="text-sm text-[#F2F0E8]">{usd(p.valueUsd)} <span className={`text-xs ${p.changePct >= 0 ? "text-green-400" : "text-red-400"}`}>{pct(p.changePct)}</span></span>
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A7A79A]">🔍</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={kind === "etf" ? "Search ETFs (SPY, QQQ…)" : "Search stocks (AAPL, Tesla…)"}
          className="w-full rounded-2xl border border-[#2A2B27] bg-[#1B1C19] py-2.5 pl-9 pr-4 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
        />
      </div>

      {loading && rows.length === 0 ? (
        [1, 2, 3, 4].map((i) => <div key={i} className="h-[68px] animate-pulse rounded-2xl border border-[#2A2B27] bg-[#1B1C19]" />)
      ) : error ? (
        <p className="py-8 text-center text-sm text-[#A7A79A]">{error}</p>
      ) : visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-[#A7A79A]">No {kind === "etf" ? "ETFs" : "stocks"} match “{query}”.</p>
      ) : (
        visible.map((r) => (
          <button
            key={r.asset}
            onClick={() => setSelected(r)}
            className="flex w-full items-center gap-3 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-left transition-colors hover:border-[#3A3B37]"
          >
            <StockLogo ticker={r.ticker} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-[#F2F0E8]">{r.ticker}</p>
              <p className="truncate text-xs text-[#A7A79A]">{r.name}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-semibold text-[#F2F0E8]">{r.price !== null ? usd(r.price) : "—"}</p>
              <p className={`text-xs ${(r.changePct ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{pct(r.changePct)}</p>
            </div>
          </button>
        ))
      )}

      <p className="px-2 text-center text-[11px] text-[#5C5D58]">
        Prices from Backpack Exchange. Trades execute on Backpack; holdings are recorded by Bluvfi. Investing involves risk.
      </p>

      {selected && (
        <StockSheet
          stock={selected}
          portfolio={portfolio}
          enabled={enabled}
          onClose={() => setSelected(null)}
          onTraded={loadPortfolio}
        />
      )}
      {cashSheet === "withdraw" && portfolio && (
        <WithdrawSheet cashUsd={portfolio.cashUsd} onClose={() => setCashSheet(null)} onDone={loadPortfolio} />
      )}
    </div>
  );
}

// ── Chart ────────────────────────────────────────────────────────────────────

function PriceChart({ asset }: { asset: string }) {
  const [range, setRange] = useState<"1w" | "1m" | "1y">("1m");
  const [points, setPoints] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stocks/chart?asset=${encodeURIComponent(asset)}&range=${range}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPoints((d.points ?? []).map((p: { close: number }) => p.close).filter((n: number) => n > 0)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [asset, range]);

  const path = useMemo(() => {
    if (points.length < 2) return "";
    const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
    return points.map((p, i) => `${i ? "L" : "M"}${(i / (points.length - 1)) * 300},${90 - ((p - min) / span) * 80}`).join(" ");
  }, [points]);
  const up = points.length > 1 && points[points.length - 1] >= points[0];

  return (
    <div>
      <svg viewBox="0 0 300 100" className="h-28 w-full" preserveAspectRatio="none" role="img" aria-label={`${asset} price chart`}>
        {path && <path d={path} fill="none" stroke={up ? "#4ADE80" : "#F87171"} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="mt-2 flex gap-2">
        {(["1w", "1m", "1y"] as const).map((r) => (
          <button key={r} onClick={() => setRange(r)} className={`rounded-full px-3 py-1 text-xs font-medium ${range === r ? "bg-[#F2F0E8] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A]"}`}>
            {r.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Trade sheet ──────────────────────────────────────────────────────────────

type GetAccessToken = () => Promise<string | null>;
type SendTransaction = ReturnType<typeof usePrivy>["sendTransaction"];

/**
 * Moves `amountUsd` of USDC (Base, gas sponsored) from the user's Bluvfi
 * wallet to Bluvfi's Backpack account and waits until the server has
 * credited it. Used inside Buy, so there's no separate "add cash" step.
 */
async function fundFromWallet(amountUsd: number, sendTransaction: SendTransaction, getAccessToken: GetAccessToken) {
  const info = await authFetch("/api/stocks/deposit", undefined, getAccessToken).then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    return d as { address: `0x${string}` };
  });
  const { hash } = await sendTransaction(
    {
      to: BASE_USDC,
      chainId: 8453,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [info.address, parseUnits(amountUsd.toFixed(2), 6)] }),
    },
    { sponsor: true },
  );
  // The receipt can take a few seconds to be visible.
  for (let i = 0; i < 20; i++) {
    const r = await authFetch("/api/stocks/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: hash }),
    }, getAccessToken);
    if (r.ok) return;
    const d = await r.json().catch(() => ({}));
    if (r.status !== 404) throw new Error(d.error ?? "Couldn't confirm your payment.");
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("Your USDC was sent but isn't confirmed yet. It'll be saved as credit once it confirms — try the buy again in a minute.");
}

type TradeStep = "form" | "review" | "funding" | "placing" | "pending" | "done" | "error";

function StockSheet({
  stock, portfolio, enabled, onClose, onTraded,
}: {
  stock: StockRow;
  portfolio: Portfolio | null;
  enabled: boolean;
  onClose: () => void;
  onTraded: () => void;
}) {
  const { getAccessToken, sendTransaction } = usePrivy();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState(""); // buy: dollars · sell: shares
  const [quote, setQuote] = useState<Quote | null>(null);
  const [step, setStep] = useState<TradeStep>("form");
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: string; fillPrice?: string | null; fillQuantity?: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const owned = Number(portfolio?.positions.find((p) => p.asset === stock.asset)?.quantity ?? 0);
  const credit = portfolio?.cashUsd ?? 0;
  const price = stock.price ?? 0;
  // Buy is entered in dollars; the exchange trades shares, so convert (the quote snaps to the allowed step).
  const shares = side === "buy" ? (price > 0 ? Number(amount) / price : 0) : Number(amount);
  const estimate = side === "buy" ? Number(amount) || 0 : shares * price;
  // What has to come from the wallet: the quote's max cost minus any credit already held.
  const fromWallet = quote && quote.side === "buy" ? Math.max(0, Math.ceil((Number(quote.estimateUsdc) - credit) * 100) / 100) : 0;

  const review = async () => {
    setMsg(null);
    try {
      const qty = side === "buy" ? shares.toFixed(6) : amount;
      const r = await fetch(`/api/stocks/quote?asset=${encodeURIComponent(stock.asset)}&side=${side}&quantity=${encodeURIComponent(qty)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setQuote(d.quote);
      setStep("review");
    } catch (e) {
      setMsg((e as Error).message || "Couldn't price this trade.");
    }
  };

  const confirm = async () => {
    if (!quote) return;
    try {
      if (fromWallet > 0) {
        setStep("funding");
        await fundFromWallet(fromWallet, sendTransaction, getAccessToken);
      }
      setStep("placing");
      const r = await authFetch("/api/stocks/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset: quote.asset, side: quote.side, quantity: quote.quantity, limitPrice: quote.limitPrice }),
      }, getAccessToken);
      const d = await r.json();
      if (!r.ok) {
        // Money already moved in stays as credit for the next buy — say so.
        throw new Error(fromWallet > 0 ? `${d.error} Your ${usd(fromWallet)} is saved as credit for your next buy.` : d.error);
      }
      let order = d.order;
      setStep("pending");
      // Deferred settlement: accepted RFQs fill shortly after. Poll for up to ~2 minutes.
      for (let i = 0; i < 40 && order.status === "pending" && alive.current; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const o = await authFetch(`/api/stocks/orders/${order.id}`, undefined, getAccessToken).then((x) => x.json()).catch(() => null);
        if (o?.order) order = o.order;
      }
      if (!alive.current) return;
      onTraded();
      setResult(order);
      if (order.status === "filled" || order.status === "pending") setStep("done");
      else {
        setStep("error");
        setMsg(order.status === "expired" || order.status === "cancelled"
          ? `No one filled the order within your price cap. ${quote.side === "buy" ? "Your money is kept as credit for your next buy" : "Your shares are unchanged"}.`
          : order.error ?? "The order failed. Nothing was charged.");
      }
    } catch (e) {
      const m = (e as Error).message ?? "The trade failed.";
      setStep("error");
      setMsg(/reject|denied|cancel/i.test(m) ? "Cancelled. Nothing was sent." : m.split("\n")[0]);
      onTraded();
    }
  };

  return (
    <Sheet title={`${stock.ticker} · ${stock.name}`} subtitle={stock.price !== null ? `${usd(stock.price)}  ${pct(stock.changePct)}` : undefined} onClose={onClose}>
      <div className="mb-3 flex items-center gap-3">
        <StockLogo ticker={stock.ticker} size="h-12 w-12" />
        <div className="min-w-0">
          <p className="text-2xl font-bold text-[#F2F0E8]">{stock.price !== null ? usd(stock.price) : "—"}</p>
          <p className={`text-xs ${(stock.changePct ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{pct(stock.changePct)} today</p>
        </div>
      </div>
      <PriceChart asset={stock.asset} />

      <div className="mt-5">
        {!enabled ? (
          <p className="rounded-2xl bg-white/[0.04] p-4 text-center text-sm text-[#A7A79A]">Trading is coming soon. Prices and charts are live.</p>
        ) : step === "done" && result ? (
          <div className="text-center">
            <p className="text-4xl">{result.status === "filled" ? "✅" : "⏳"}</p>
            <p className="mt-2 font-semibold text-[#F2F0E8]">
              {result.status === "filled"
                ? `${side === "buy" ? "Bought" : "Sold"} ${Number(result.fillQuantity)} ${stock.ticker} at ${usd(Number(result.fillPrice))}`
                : "Order accepted — settling"}
            </p>
            <p className="mt-1 text-xs text-[#A7A79A]">
              {result.status !== "filled"
                ? "It usually settles within a few minutes. Your holdings update when it does."
                : side === "sell"
                  ? "The money is on its way to your wallet as USDC."
                  : "Your holdings are updated."}
            </p>
            <button onClick={onClose} className="mt-5 w-full rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513]">Done</button>
          </div>
        ) : step === "error" ? (
          <div className="text-center">
            <p className="text-3xl">⚠️</p>
            <p className="mt-2 text-sm text-[#F2F0E8]">{msg}</p>
            <button onClick={() => { setStep("form"); setMsg(null); }} className="mt-4 rounded-2xl bg-white/[0.06] px-6 py-2.5 text-sm font-semibold text-[#F2F0E8]">Back</button>
          </div>
        ) : step === "funding" || step === "placing" || step === "pending" ? (
          <div className="py-6 text-center">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
            <p className="mt-3 text-sm font-semibold text-[#F2F0E8]">
              {step === "funding" ? `Approve ${usd(fromWallet)} USDC in your wallet…` : step === "placing" ? "Sending your order…" : "Getting the best price…"}
            </p>
            {step === "funding" && <p className="mt-1 text-xs text-[#A7A79A]">No gas needed. Then we place the order.</p>}
          </div>
        ) : step === "review" && quote ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-sm">
              {[
                [quote.side === "buy" ? "Buy" : "Sell", `${Number(quote.quantity)} ${stock.ticker}`],
                ["Market price", usd(quote.marketPrice)],
                [quote.side === "buy" ? "Max price per share" : "Min price per share", usd(Number(quote.limitPrice))],
                ["Bluvfi fee (est.)", usd(Number(quote.feeUsdc))],
                [quote.side === "buy" ? "You pay at most" : "You receive at least", usd(Number(quote.estimateUsdc))],
                ...(quote.side === "buy" && credit >= 0.01 ? [["Paid from credit", usd(Math.min(credit, Number(quote.estimateUsdc)))]] : []),
                ...(quote.side === "buy" ? [["From your wallet (USDC)", usd(fromWallet)]] : [["Paid to", "Your wallet (USDC)"]]),
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between py-1"><span className="text-[#A7A79A]">{k}</span><span className="text-[#F2F0E8]">{v}</span></div>
              ))}
            </div>
            <p className="text-center text-[11px] text-[#A7A79A]">
              {quote.side === "buy"
                ? "Filled at or better than your max price; anything unused is kept as credit for your next buy."
                : "Filled at or better than your min price; the money goes straight to your wallet."}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setStep("form")} className="flex-1 rounded-2xl bg-white/[0.06] py-3 text-sm font-semibold text-[#F2F0E8]">Back</button>
              <button onClick={confirm} className="flex-1 rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513]">
                Confirm {quote.side}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {(["buy", "sell"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => { setSide(s); setAmount(""); setMsg(null); }}
                  disabled={s === "sell" && !owned}
                  className={`rounded-2xl py-2.5 text-sm font-semibold disabled:opacity-40 ${side === s ? "bg-[#F2F0E8] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A]"}`}
                >
                  {s === "buy" ? "Buy" : `Sell${owned ? ` (${owned})` : ""}`}
                </button>
              ))}
            </div>
            <div className="relative">
              {side === "buy" && <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-[#A7A79A]">$</span>}
              <input
                type="number"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={side === "buy" ? "Amount in USD (e.g. 50)" : "Shares to sell"}
                className={`w-full rounded-2xl border border-[#2A2B27] bg-[#1B1C19] py-3 pr-4 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none ${side === "buy" ? "pl-8" : "pl-4"}`}
              />
              {side === "sell" && owned > 0 && (
                <button onClick={() => setAmount(String(owned))} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg bg-white/[0.06] px-2 py-1 text-xs font-semibold text-[#F2F0E8]">Max</button>
              )}
            </div>
            <p className="text-xs text-[#A7A79A]">
              {side === "buy"
                ? `≈ ${shares > 0 ? shares.toFixed(4) : "0"} ${stock.ticker} · paid with USDC from your wallet, no gas`
                : `≈ ${usd(estimate)} to your wallet · you own ${owned} ${stock.ticker}`}
            </p>
            {msg && <p className="text-xs text-red-400">{msg}</p>}
            <button onClick={review} disabled={!(Number(amount) > 0)} className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-40">
              Review {side === "buy" && Number(amount) > 0 ? `${usd(Number(amount))} buy` : side}
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ── Leftover credit → wallet ─────────────────────────────────────────────────

function WithdrawSheet({ cashUsd, onClose, onDone }: { cashUsd: number; onClose: () => void; onDone: () => void }) {
  const { getAccessToken } = usePrivy();
  const [amount, setAmount] = useState("");
  const [state, setState] = useState<"form" | "sending" | "sent" | "queued" | "error">("form");
  const [msg, setMsg] = useState<string | null>(null);

  const withdraw = async () => {
    setState("sending");
    try {
      const r = await authFetch("/api/stocks/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      }, getAccessToken);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onDone();
      setState(d.status === "queued" ? "queued" : "sent");
    } catch (e) {
      setState("error");
      setMsg((e as Error).message || "Withdrawal failed.");
    }
  };

  return (
    <Sheet title="Send credit to wallet" subtitle={`${usd(cashUsd)} credit · sent as USDC on Base`} onClose={onClose}>
      {state === "sent" || state === "queued" ? (
        <div className="text-center">
          <p className="text-4xl">{state === "sent" ? "✅" : "⏳"}</p>
          <p className="mt-2 font-semibold text-[#F2F0E8]">{state === "sent" ? "On its way to your wallet" : "Withdrawal requested"}</p>
          <p className="mt-1 text-xs text-[#A7A79A]">{state === "sent" ? "Usually arrives within a few minutes." : "Our team sends it to your Bluvfi wallet, usually within 24 hours."}</p>
          <button onClick={onClose} className="mt-5 w-full rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513]">Done</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount in USDC"
              className="flex-1 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
            />
            <button onClick={() => setAmount((Math.floor(cashUsd * 100) / 100).toFixed(2))} className="rounded-2xl bg-white/[0.06] px-4 text-xs font-semibold text-[#F2F0E8]">Max</button>
          </div>
          {msg && <p className="text-xs text-red-400">{msg}</p>}
          <button
            onClick={withdraw}
            disabled={state === "sending" || !(Number(amount) >= 1) || Number(amount) > cashUsd}
            className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-40"
          >
            {state === "sending" ? "Sending…" : "Withdraw to my wallet"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
