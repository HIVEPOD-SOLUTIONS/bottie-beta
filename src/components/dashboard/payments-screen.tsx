"use client";

import { usePayments } from "@/hooks/use-payments";
import { useWeeklyInsight } from "@/hooks/use-weekly-insight";

// ── Icons for every payment type ─────────────────────────────────────────────

const TYPE_META: Record<string, { icon: string; label: string; network?: string }> = {
  bill:        { icon: "🧾", label: "Bill / Gift Card" },
  investment:  { icon: "📈", label: "Investment" },
  transfer:    { icon: "↗️",  label: "Transfer" },
  bridge:      { icon: "🌉", label: "Bridge" },
  nanopay:     { icon: "⚡", label: "Circle Nanopay", network: "Base" },
  solpay:      { icon: "◎",  label: "Solana Nanopay", network: "Solana" },
  x402:        { icon: "🔑", label: "x402 Payment" },
  deposit:     { icon: "⬇️",  label: "Gateway Deposit" },
  withdrawal:  { icon: "⬆️",  label: "Gateway Withdrawal" },
  onramp:      { icon: "🏦", label: "Onramp (INR→Crypto)" },
  offramp:     { icon: "💸", label: "Offramp (Crypto→INR)" },
};

const STATUS_STYLE: Record<string, string> = {
  completed:  "text-green-400",
  pending:    "text-yellow-400",
  processing: "text-blue-400",
  failed:     "text-red-400",
};

function formatDate(iso: string | Date) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month:  "short",
      day:    "numeric",
      hour:   "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

function networkLabel(type: string, chain?: string | null) {
  if (chain === "solana") return "◎ Solana";
  if (chain === "evm")    return "🔷 Base";
  return TYPE_META[type]?.network ?? "";
}

// ── Category display names for the insight card ──────────────────────────────
const CATEGORY_LABELS: Record<string, string> = {
  bill:       "digital products",
  investment: "investments",
  bridge:     "cross-chain bridges",
  transfer:   "transfers",
  nanopay:    "nanopayments",
  solpay:     "Solana payments",
  x402:       "x402 payments",
  onramp:     "crypto onramps",
  offramp:    "crypto offramps",
  deposit:    "deposits",
  withdrawal: "withdrawals",
};

export function PaymentsScreen() {
  const { payments, loading, error, refetch } = usePayments();
  const {
    insight,
    isLoading: insightLoading,
    isGenerating,
    generate: refreshInsight,
  } = useWeeklyInsight();

  const totalSpent = payments.reduce(
    (sum, p) => sum + (p.status !== "failed" ? parseFloat(p.amountUsdc ?? "0") : 0),
    0,
  );

  const balanceDelta = insight ? parseFloat(insight.balanceDeltaUsd ?? "0") : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary card */}
      <div className="rounded-3xl bg-[#8FAE82] p-5">
        <p className="text-sm font-medium text-[#141513]/70">Total Transacted</p>
        <p className="mt-1 text-3xl font-bold text-[#141513]">
          ${totalSpent.toFixed(2)}
        </p>
        <p className="mt-1 text-sm text-[#141513]/60">
          {payments.length} transaction{payments.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* ── Weekly Insight card ─────────────────────────────────────────── */}
      {(insightLoading || isGenerating || insight) && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-base">✨</span>
              <p className="text-xs font-semibold text-[#A7A79A] uppercase tracking-wider">
                Weekly Insight
              </p>
            </div>
            <button
              onClick={refreshInsight}
              disabled={isGenerating}
              className="text-[10px] text-[#8FAE82] disabled:opacity-40 hover:underline"
            >
              {isGenerating ? "Generating…" : "Refresh"}
            </button>
          </div>

          {(insightLoading || isGenerating) && !insight ? (
            // Skeleton while first generation runs
            <div className="space-y-2 animate-pulse">
              <div className="h-3 w-full rounded bg-white/[0.06]" />
              <div className="h-3 w-5/6 rounded bg-white/[0.06]" />
              <div className="h-3 w-4/6 rounded bg-white/[0.06]" />
            </div>
          ) : insight ? (
            <>
              <p className="text-sm text-[#F2F0E8] leading-relaxed">
                {insight.summary}
              </p>
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                {insight.topCategory && (
                  <span className="rounded-full border border-[#2A2B27] bg-white/[0.04] px-2.5 py-1 text-[10px] text-[#A7A79A]">
                    Top: {CATEGORY_LABELS[insight.topCategory] ?? insight.topCategory}
                  </span>
                )}
                {balanceDelta !== null && (
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-medium ${
                      balanceDelta >= 0
                        ? "border-green-800/40 bg-green-900/20 text-green-400"
                        : "border-red-800/40 bg-red-900/20 text-red-400"
                    }`}
                  >
                    Balance {balanceDelta >= 0 ? "▲" : "▼"} $
                    {Math.abs(balanceDelta).toFixed(2)}
                  </span>
                )}
                <span className="text-[10px] text-[#A7A79A]">
                  Week of {insight.weekStart}
                </span>
              </div>
            </>
          ) : null}
        </div>
      )}

      {loading && (
        <div className="flex flex-col gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-white/[0.04]" />
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-red-900/30 bg-red-900/10 px-4 py-3 text-sm text-red-400">
          {error}
          <button onClick={refetch} className="ml-3 underline text-xs">Retry</button>
        </div>
      )}

      {!loading && !error && payments.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-4xl">💳</p>
          <p className="mt-2 font-semibold text-[#F2F0E8]">No transactions yet</p>
          <p className="mt-1 text-sm text-[#A7A79A]">
            Pay a bill, invest, bridge, or use nanopayments to see your history here
          </p>
        </div>
      )}

      {!loading && payments.length > 0 && (
        <div className="flex flex-col gap-2">
          {payments.map((payment) => {
            const meta = TYPE_META[payment.type] ?? { icon: "💳", label: payment.type };
            const statusCls = STATUS_STYLE[payment.status] ?? "text-[#A7A79A]";
            const net = networkLabel(payment.type, payment.chain);
            const amt = parseFloat(payment.amountUsdc ?? "0");

            return (
              <div
                key={payment.id}
                className="flex items-center gap-3 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4"
              >
                {/* Icon */}
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-xl">
                  {meta.icon}
                </div>

                {/* Description + timestamp */}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[#F2F0E8]">
                    {payment.description}
                  </p>
                  <p className="text-xs text-[#A7A79A]">
                    {meta.label}
                    {net ? ` · ${net}` : ""}
                    {" · "}
                    {formatDate(payment.createdAt)}
                  </p>
                </div>

                {/* Amount + status */}
                <div className="shrink-0 text-right">
                  <p className="font-semibold text-[#F2F0E8]">
                    ${amt >= 0.01 ? amt.toFixed(2) : amt.toFixed(6)}
                  </p>
                  <p className={`text-xs capitalize ${statusCls}`}>
                    {payment.status}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
