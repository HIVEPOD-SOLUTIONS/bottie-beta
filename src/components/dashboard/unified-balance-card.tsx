"use client";

import { useUnifiedBalance } from "@/hooks/use-unified-balance";

interface Props {
  /** Called when user taps Bridge on an empty-chain row */
  onBridge?: () => void;
}

export function UnifiedBalanceCard({ onBridge }: Props) {
  const { state, refresh } = useUnifiedBalance({ includePending: true, autoRefreshMs: 30_000 });

  // ── Loading skeleton ───────────────────────────────────────────────────────
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 animate-pulse">
        <div className="mb-4 flex items-center justify-between">
          <div className="h-3 w-24 rounded bg-[#2A2B27]" />
          <div className="h-6 w-20 rounded bg-[#2A2B27]" />
        </div>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flex items-center justify-between py-2.5 border-t border-[#2A2B27]">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-[#2A2B27]" />
              <div className="h-3 w-24 rounded bg-[#2A2B27]" />
            </div>
            <div className="h-3 w-16 rounded bg-[#2A2B27]" />
          </div>
        ))}
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (state.status === "error") {
    return (
      <div className="rounded-2xl border border-red-900/30 bg-red-900/10 p-4">
        <p className="text-xs text-red-400">{state.message}</p>
        <button onClick={refresh} className="mt-2 text-xs text-[#8FAE82] underline">
          Retry
        </button>
      </div>
    );
  }

  const { totalUsdc, chains, fundedCount, emptyCount, lastFetched } = state;

  return (
    <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div>
          <p className="text-xs text-[#A7A79A] font-medium">Total USDC · All Networks</p>
          <p className="mt-0.5 text-2xl font-bold text-[#F2F0E8]">${totalUsdc}</p>
        </div>
        <div className="text-right">
          <button
            onClick={refresh}
            className="rounded-full p-1.5 text-[#A7A79A] hover:text-[#F2F0E8] transition-colors"
            title="Refresh balances"
          >
            ↻
          </button>
          <p className="text-[10px] text-[#A7A79A] mt-0.5">
            {lastFetched.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
      </div>

      {/* Summary pills */}
      <div className="flex gap-2 px-4 pb-3">
        <span className="rounded-full bg-[#8FAE82]/15 px-2.5 py-1 text-[10px] font-medium text-[#8FAE82]">
          {fundedCount} network{fundedCount !== 1 ? "s" : ""} with funds
        </span>
        {emptyCount > 0 && (
          <span className="rounded-full bg-white/[0.05] px-2.5 py-1 text-[10px] font-medium text-[#A7A79A]">
            {emptyCount} empty
          </span>
        )}
      </div>

      {/* Per-chain rows */}
      <div className="divide-y divide-[#2A2B27] border-t border-[#2A2B27]">
        {chains.map((c) => {
          const isEmpty = !c.hasFunds;
          return (
            <div
              key={c.chain}
              className={`flex items-center justify-between px-4 py-3 transition-opacity ${
                isEmpty ? "opacity-40" : "opacity-100"
              }`}
            >
              {/* Chain info */}
              <div className="flex items-center gap-3">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm"
                  style={{ background: `${c.color}20`, color: c.color }}
                >
                  {c.icon}
                </div>
                <div>
                  <p className="text-sm font-medium text-[#F2F0E8]">{c.label}</p>
                  {c.pendingBalance && (
                    <p className="text-[10px] text-[#A7A79A]">
                      +${c.pendingBalance} pending
                    </p>
                  )}
                </div>
              </div>

              {/* Balance or empty state */}
              <div className="text-right">
                {isEmpty ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#A7A79A]">No funds</span>
                    {onBridge && (
                      <button
                        onClick={onBridge}
                        className="rounded-lg border border-[#2A2B27] px-2.5 py-1 text-[10px] font-medium text-[#8FAE82] hover:border-[#8FAE82]/40 transition-colors"
                      >
                        Bridge →
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="font-mono text-sm font-semibold text-[#F2F0E8]">
                    ${c.confirmedBalance}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer hint when there are empty chains */}
      {emptyCount > 0 && (
        <div className="border-t border-[#2A2B27] px-4 py-3">
          <p className="text-[11px] text-[#A7A79A]">
            Dimmed networks have no USDC.{" "}
            {onBridge && (
              <button onClick={onBridge} className="text-[#8FAE82] underline">
                Bridge funds in
              </button>
            )}{" "}
            to use them.
          </p>
        </div>
      )}
    </div>
  );
}
