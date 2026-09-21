"use client";

import { useEffect, useRef, useState } from "react";
import { useCryptoPrices } from "@/hooks/use-crypto-prices";
import type { CoinPrice } from "@/lib/coinmarketcap-parse";

/** $64,231.55 for normal prices; more decimals below $1 so a coin like XRP still shows movement. */
function formatCoinPrice(n: number): string {
  const decimals = n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function PriceChip({ coin }: { coin: CoinPrice }) {
  // Brief green/red flash when the price ticks, so movement is noticeable
  // without watching the numbers.
  const prev = useRef(coin.priceUsd);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (coin.priceUsd === prev.current) return;
    setFlash(coin.priceUsd > prev.current ? "up" : "down");
    prev.current = coin.priceUsd;
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [coin.priceUsd]);

  const change = coin.change24h;
  const up = change !== null && change >= 0;

  return (
    <div className="flex shrink-0 flex-col rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] font-semibold text-[#A7A79A]">{coin.symbol}</span>
        {change !== null && (
          <span className={`text-[10px] font-medium tabular-nums ${up ? "text-green-400" : "text-red-400"}`}>
            {up ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%
          </span>
        )}
      </div>
      <span
        className={`mt-0.5 text-sm font-bold tabular-nums transition-colors duration-700 ${
          flash === "up" ? "text-green-400" : flash === "down" ? "text-red-400" : "text-[#F2F0E8]"
        }`}
      >
        {formatCoinPrice(coin.priceUsd)}
      </span>
    </div>
  );
}

/**
 * Live crypto price strip for the dashboard. Renders nothing when the feed
 * isn't configured or has never loaded — a missing ticker is better than an
 * error banner on the home screen for something that's purely informational.
 */
export function PriceTicker({ className = "" }: { className?: string }) {
  const { data, isPending, isError } = useCryptoPrices();

  if (isError && !data) return null;

  if (isPending) {
    return (
      <div className={`flex gap-2 overflow-hidden ${className}`} aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[52px] w-[110px] shrink-0 animate-pulse rounded-xl bg-white/[0.04]" />
        ))}
      </div>
    );
  }
  if (!data || data.prices.length === 0) return null;

  return (
    <div className={className}>
      <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {data.prices.map((coin) => (
          <PriceChip key={coin.symbol} coin={coin} />
        ))}
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-[#A7A79A]">
        <span
          className={`h-1.5 w-1.5 rounded-full ${data.stale ? "bg-amber-400" : "animate-pulse bg-green-400"}`}
        />
        {data.stale ? "Delayed" : "Live"} · via CoinMarketCap
      </p>
    </div>
  );
}
