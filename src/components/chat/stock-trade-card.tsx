"use client";

import { useEffect, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { pickPrivyWalletOrThrow } from "@/lib/evm-pay";
import { authFetch } from "@/lib/api-auth-fetch";
import {
  executeStockTrade,
  watchStockOrder,
  walletShare,
  orderFailureMessage,
  friendlyTradeError,
  type StockQuote,
  type TradeStep,
} from "@/lib/stocks-client";
import { StockLogo } from "@/components/dashboard/stocks-section";

/**
 * Confirm card for the AI's trade_stock tool — the same trade as Invest →
 * Backpack. Nothing happens until the user taps Confirm; then it refreshes
 * the price, pays from the wallet (buys), places the order and reports
 * {done, …} back to the chat. Once reported, a re-render shows the result
 * instead of offering to trade again.
 */

type Output = {
  pendingStockTrade: true;
  ticker: string;
  name: string;
  side: "buy" | "sell";
  quote: StockQuote;
  // Set after the card reports back:
  done?: boolean;
  orderId?: string;
  status?: string;
  fillPrice?: string | null;
  fillQuantity?: string | null;
  error?: string;
};

type State = "idle" | "refreshing" | TradeStep | "done" | "error";

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function StockTradeCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: Output;
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
}) {
  const { getAccessToken, sendTransaction } = usePrivy();
  const { wallets } = useWallets();
  const [quote, setQuote] = useState<StockQuote>(output.quote);
  const [credit, setCredit] = useState(0);
  const [state, setState] = useState<State>(output.done === true ? "done" : output.done === false ? "error" : "idle");
  const [msg, setMsg] = useState<string | null>(output.done === false ? output.error ?? "The trade didn't go through." : null);
  const [order, setOrder] = useState<{ status: string; fillPrice?: string | null; fillQuantity?: string | null } | null>(
    output.done ? { status: output.status ?? "pending", fillPrice: output.fillPrice, fillQuantity: output.fillQuantity } : null,
  );
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const report = (result: Record<string, unknown>) =>
    addToolResult({ tool: "trade_stock", toolCallId, output: { ...output, ...result } });

  // Any leftover credit is used first, so the wallet only pays the rest.
  useEffect(() => {
    if (output.done !== undefined || output.side !== "buy") return;
    authFetch("/api/stocks/portfolio", undefined, getAccessToken)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && alive.current) setCredit(Number(d.cashUsd) || 0); })
      .catch(() => {});
  }, [output.done, output.side, getAccessToken]);

  // Reported as still settling in an earlier render: keep watching it.
  useEffect(() => {
    if (!output.done || output.status !== "pending" || !output.orderId) return;
    watchStockOrder({ id: output.orderId, status: "pending" }, getAccessToken, () => alive.current)
      .then((o) => { if (alive.current) setOrder(o); });
  }, [output.done, output.status, output.orderId, getAccessToken]);

  const confirm = async () => {
    setMsg(null);
    try {
      // Prices move — re-quote the same size right before paying.
      setState("refreshing");
      const r = await fetch(`/api/stocks/quote?asset=${encodeURIComponent(quote.asset)}&side=${quote.side}&quantity=${encodeURIComponent(quote.quantity)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      const fresh: StockQuote = d.quote;
      setQuote(fresh);

      const result = await executeStockTrade({
        quote: fresh, creditUsd: credit, sendTransaction, wallet: pickPrivyWalletOrThrow(wallets), getAccessToken, onStep: setState, isAlive: () => alive.current,
      });
      setOrder(result);
      if (result.status === "filled" || result.status === "pending") {
        setState("done");
        report({ done: true, orderId: result.id, status: result.status, fillPrice: result.fillPrice, fillQuantity: result.fillQuantity });
      } else {
        const m = orderFailureMessage(result, fresh.side);
        setState("error");
        setMsg(m);
        report({ done: false, error: m });
      }
    } catch (e) {
      const m = friendlyTradeError(e);
      setState("error");
      setMsg(m);
      report({ done: false, error: m });
    }
  };

  const busy = state === "refreshing" || state === "funding" || state === "placing" || state === "pending";
  const fromWallet = walletShare(quote, credit);

  return (
    <div className="my-2 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <div className="flex items-center gap-3">
        <StockLogo ticker={output.ticker} size="h-10 w-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#F2F0E8]">
            {output.side === "buy" ? "Buy" : "Sell"} {Number(quote.quantity)} {output.ticker}
          </p>
          <p className="truncate text-xs text-[#A7A79A]">{output.name} · Backpack</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-bold text-[#F2F0E8]">{usd(Number(quote.estimateUsdc))}</p>
          <p className="text-[10px] text-[#A7A79A]">{output.side === "buy" ? "max, incl. fee" : "min to wallet"}</p>
        </div>
      </div>

      {state === "idle" && (
        <>
          <div className="mt-3 space-y-1 text-xs">
            {[
              ["Market price", usd(quote.marketPrice)],
              [output.side === "buy" ? "Max per share" : "Min per share", usd(Number(quote.limitPrice))],
              ["Bluvfi fee (est.)", usd(Number(quote.feeUsdc))],
              ...(output.side === "buy" ? [["From your wallet", `${usd(fromWallet)} USDC · no gas`]] : [["Paid to", "Your wallet (USDC)"]]),
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between"><span className="text-[#A7A79A]">{k}</span><span className="text-[#F2F0E8]">{v}</span></div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => { setState("error"); setMsg("Cancelled. Nothing was traded."); report({ done: false, error: "Cancelled by user" }); }}
              className="flex-1 rounded-xl bg-white/[0.06] py-2.5 text-xs font-semibold text-[#F2F0E8]"
            >Cancel</button>
            <button onClick={confirm} className="flex-1 rounded-xl bg-[#8FAE82] py-2.5 text-xs font-semibold text-[#141513]">
              Confirm {output.side}
            </button>
          </div>
        </>
      )}

      {busy && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[#A7A79A]">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
          {state === "refreshing" ? "Checking the latest price…"
            : state === "funding" ? `Approve ${usd(fromWallet)} USDC in your wallet…`
            : state === "placing" ? "Sending your order…"
            : "Getting the best price…"}
        </div>
      )}

      {state === "done" && order && (
        <p className="mt-3 text-xs text-[#F2F0E8]">
          {order.status === "filled"
            ? `✅ ${output.side === "buy" ? "Bought" : "Sold"} ${Number(order.fillQuantity)} ${output.ticker} at ${usd(Number(order.fillPrice))}${output.side === "sell" ? " — money on its way to your wallet." : "."}`
            : "⏳ Order accepted — settling. Your holdings update in a few minutes."}
        </p>
      )}

      {state === "error" && msg && <p className="mt-3 text-xs text-red-400">{msg}</p>}
    </div>
  );
}
