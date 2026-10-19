"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { usePrivy } from "@privy-io/react-auth";
import { authFetch } from "@/lib/api-auth-fetch";
import { formatCompact } from "@/lib/format";

/** One row of GET /api/prices/all. */
interface Coin {
  id: number | string;
  symbol: string;
  name: string;
  rank: number | null;
  priceUsd: number;
  change24h: number | null;
  marketCap: number | null;
  providers: string[];
}
interface Page { coins: Coin[]; nextStart: number | null }

const PAGE = 100;

function price(n: number): string {
  const decimals = n >= 1 ? 2 : n >= 0.01 ? 4 : n >= 0.0001 ? 6 : 8;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function CoinRow({ coin }: { coin: Coin }) {
  const change = coin.change24h;
  const up = change !== null && change >= 0;
  return (
    <div className="flex items-center gap-3 border-b border-[#2A2B27]/60 px-5 py-3">
      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-[#A7A79A]">{coin.rank ?? "–"}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[#F2F0E8]">
          {coin.symbol}
          {coin.providers.length > 0 && (
            <span className="ml-1.5 rounded-md bg-[#8FAE82]/15 px-1.5 py-0.5 align-middle text-[9px] font-medium text-[#8FAE82]">Bluvfi</span>
          )}
        </p>
        <p className="truncate text-[11px] text-[#A7A79A]">{coin.name}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-bold tabular-nums text-[#F2F0E8]">{price(coin.priceUsd)}</p>
        <p className="text-[11px] tabular-nums text-[#A7A79A]">
          {change !== null && (
            <span className={up ? "text-green-400" : "text-red-400"}>{up ? "▲" : "▼"} {Math.abs(change).toFixed(2)}%</span>
          )}
          {coin.marketCap ? <span className="ml-2">{formatCompact(coin.marketCap)}</span> : null}
        </p>
      </div>
    </div>
  );
}

/**
 * Every coin CoinMarketCap lists, by market cap, 100 at a time as you scroll, plus a ticker search. Opens from the price
 * strip's "All coins" chip. If CoinMarketCap is down the website falls back to CoinGecko (fallback=1 on the request).
 */
export function AllCoinsSheet({ onClose }: { onClose: () => void }) {
  const { getAccessToken } = usePrivy();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const sentinel = useRef<HTMLDivElement>(null);

  // Wait for a pause in typing before looking a ticker up.
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim().toUpperCase()), 350);
    return () => clearTimeout(t);
  }, [text]);

  const list = useInfiniteQuery({
    queryKey: ["all-coins"],
    initialPageParam: 1,
    queryFn: async ({ pageParam }): Promise<Page> => {
      const res = await authFetch(`/api/prices/all?start=${pageParam}&limit=${PAGE}&fallback=1`, undefined, getAccessToken);
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Prices unavailable (${res.status})`);
      return res.json();
    },
    getNextPageParam: (last) => last.nextStart ?? undefined,
    staleTime: 30_000,
    retry: 1,
  });

  const found = useQuery({
    queryKey: ["all-coins-search", search],
    enabled: /^[A-Z0-9]{1,12}$/.test(search),
    queryFn: async (): Promise<Coin[]> => {
      const res = await authFetch(`/api/prices/all?symbol=${encodeURIComponent(search)}`, undefined, getAccessToken);
      if (!res.ok) throw new Error(`Couldn't look up ${search}`);
      return ((await res.json()) as { coins: Coin[] }).coins;
    },
    staleTime: 30_000,
    retry: 0,
  });

  const searching = text.trim().length > 0;
  const coins = list.data?.pages.flatMap((p) => p.coins) ?? [];

  // Load the next page when the bottom of the list scrolls into view.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || searching) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [searching, hasNextPage, isFetchingNextPage, fetchNextPage, coins.length]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sheet = (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-3xl border-t border-[#2A2B27] bg-[#1B1C19]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pb-3 pt-6">
          <h3 className="text-lg font-semibold text-[#F2F0E8]">All coins</h3>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-[#A7A79A] hover:bg-white/[0.06]">✕</button>
        </div>
        <div className="px-5 pb-3">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search by ticker, e.g. PEPE"
            spellCheck={false}
            autoCapitalize="characters"
            className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] outline-none placeholder:text-[#A7A79A]/60 focus:border-[#8FAE82]"
          />
        </div>

        <div className="min-h-[40dvh] flex-1 overflow-y-auto overscroll-contain">
          {searching ? (
            found.isFetching ? (
              <p className="px-6 py-8 text-center text-xs text-[#A7A79A]">Looking up {search}…</p>
            ) : found.data && found.data.length > 0 ? (
              found.data.map((c) => <CoinRow key={c.id} coin={c} />)
            ) : (
              <p className="px-6 py-8 text-center text-xs text-[#A7A79A]">
                {/^[A-Z0-9]{1,12}$/.test(search) ? `No coin with the ticker ${search}.` : "Enter a ticker (letters and numbers only)."}
              </p>
            )
          ) : list.isPending ? (
            <p className="px-6 py-8 text-center text-xs text-[#A7A79A]">Loading coins…</p>
          ) : list.isError && coins.length === 0 ? (
            <div className="px-6 py-8 text-center">
              <p className="text-xs text-red-400">{list.error instanceof Error ? list.error.message : "Prices are unavailable right now."}</p>
              <button onClick={() => void list.refetch()} className="mt-3 rounded-lg border border-[#2A2B27] px-3 py-1.5 text-xs text-[#A7A79A]">Try again</button>
            </div>
          ) : (
            <>
              {coins.map((c) => <CoinRow key={c.id} coin={c} />)}
              <div ref={sentinel} className="px-6 py-5 text-center text-[11px] text-[#A7A79A]">
                {isFetchingNextPage ? "Loading more…" : hasNextPage ? "" : "That's every coin listed."}
                {list.isError && coins.length > 0 && (
                  <button onClick={() => void fetchNextPage()} className="ml-2 text-[#8FAE82]">Retry</button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
  return createPortal(sheet, document.body);
}
