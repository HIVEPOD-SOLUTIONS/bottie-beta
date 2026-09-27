"use client";

import { useEffect, useState, useCallback } from "react";

type BaseStockToken = {
  contract_address: string;
  symbol: string;
  name: string;
  decimals: number;
  icon_url?: string;
  total_supply: number;
  isin?: string;
  multiplier: number;
  paused_features?: number[];
  nav_price?: number;
  nav_price_updated_at?: string;
  totalSharesEquivalent: number | null;
  navPriceAgeHours: number | null;
  navPriceStale: boolean | null;
};

async function apiFetch<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch("/api/base-stocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, ...params }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

function fmtUsd(n: number | null | undefined) {
  if (n == null) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtAge(hours: number | null) {
  if (hours == null) return null;
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${hours.toFixed(1)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function TokenCard({ t }: { t: BaseStockToken }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      onClick={() => setExpanded((v) => !v)}
      className="flex w-full flex-col gap-2 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-left transition-colors hover:border-[#3A3B37]"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl overflow-hidden bg-white/[0.06]">
          {t.icon_url ? (
            <img src={t.icon_url} alt={t.symbol} className="h-full w-full object-cover" />
          ) : (
            <span className="text-sm font-semibold text-[#A7A79A]">{t.symbol?.slice(0, 4)}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-[#F2F0E8]">{t.symbol}</p>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-[#A7A79A] truncate max-w-[10rem]">{t.name}</span>
          </div>
          <p className="truncate text-xs text-[#A7A79A] mt-0.5">
            NAV {fmtUsd(t.nav_price)}
            {t.navPriceStale ? (
              <span className="ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-amber-400 bg-amber-400/10">
                stale{fmtAge(t.navPriceAgeHours) ? ` · ${fmtAge(t.navPriceAgeHours)}` : ""}
              </span>
            ) : fmtAge(t.navPriceAgeHours) ? (
              <span className="ml-2 text-[#6B6C63]">{fmtAge(t.navPriceAgeHours)}</span>
            ) : null}
          </p>
        </div>
        <svg className={`shrink-0 text-[#A7A79A] transition-transform ${expanded ? "rotate-90" : ""}`} width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {expanded && (
        <div className="mt-1 grid grid-cols-2 gap-2 border-t border-[#2A2B27] pt-3 text-xs">
          <div>
            <p className="text-[#6B6C63]">Multiplier</p>
            <p className="text-[#F2F0E8]">{t.multiplier?.toFixed(4) ?? "—"}</p>
          </div>
          <div>
            <p className="text-[#6B6C63]">Total supply (tokens)</p>
            <p className="text-[#F2F0E8]">{t.total_supply?.toLocaleString() ?? "—"}</p>
          </div>
          <div>
            <p className="text-[#6B6C63]">≈ underlying shares</p>
            <p className="text-[#F2F0E8]">{t.totalSharesEquivalent != null ? t.totalSharesEquivalent.toLocaleString() : "—"}</p>
          </div>
          <div>
            <p className="text-[#6B6C63]">ISIN</p>
            <p className="text-[#F2F0E8]">{t.isin || "—"}</p>
          </div>
          <div className="col-span-2">
            <p className="text-[#6B6C63]">Contract (Base)</p>
            <p className="text-[#F2F0E8] font-mono break-all">{t.contract_address}</p>
          </div>
        </div>
      )}
    </button>
  );
}

export function BaseStocksSection() {
  const [tokens, setTokens] = useState<BaseStockToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async (q?: string) => {
    setLoading(true);
    setErr("");
    try {
      const data = await apiFetch<{ tokens: BaseStockToken[] }>("list", q ? { query: q } : {});
      setTokens(data.tokens ?? []);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-3 text-xs text-[#A7A79A]">
        Read-only reference data from Coinbase's public Tokenized Stocks API — contract address, NAV/reference price,
        multiplier and supply on Base. Not a live bid/ask, and not available for trading in Bluvfi. These tokens are
        restricted to persons outside the United States in eligible jurisdictions; listing here doesn't mean you're eligible to hold one.
      </div>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") load(query); }}
          placeholder="Search symbol or company, e.g. AAPL"
          className="flex-1 rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] placeholder:text-[#6B6C63] outline-none focus:border-[#3A3B37]"
        />
        <button
          onClick={() => load(query)}
          className="rounded-xl bg-white/[0.06] px-4 py-2 text-sm font-medium text-[#F2F0E8] hover:bg-white/[0.1]"
        >
          Search
        </button>
      </div>

      {loading && (
        <div className="flex flex-col gap-3 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 rounded-2xl bg-white/[0.04]" />)}
        </div>
      )}

      {!loading && err && (
        <div className="rounded-2xl border border-red-900/30 bg-red-900/10 px-4 py-3 text-sm text-red-400">
          {err}
          <button onClick={() => load(query)} className="ml-3 underline text-xs">Retry</button>
        </div>
      )}

      {!loading && !err && tokens.length === 0 && (
        <p className="py-8 text-center text-sm text-[#A7A79A]">No tokens matched.</p>
      )}

      {!loading && !err && tokens.length > 0 && (
        <div className="flex flex-col gap-3">
          {tokens.map((t) => <TokenCard key={t.contract_address} t={t} />)}
        </div>
      )}
    </div>
  );
}
