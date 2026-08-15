"use client";

import { VAULT_FRIENDLY_NAMES } from "@/lib/constants";
import { BuyAssetConfirmCard } from "./buy-asset-confirm-card";
import { useDemoState } from "@/contexts/demo-state-context";

/** Shows the right number of decimal places for any USDC amount down to $0.000001. */
function fmtUsdc(n: number): string {
  if (n >= 0.01) return n.toFixed(2);
  if (n >= 0.0001) return n.toFixed(4);
  return n.toFixed(6);
}

/** Friendly label for a CAIP-2 network ID */
function networkLabel(net: string | null | undefined): string {
  if (!net) return "Unknown network";
  if (net === "eip155:8453") return "🔷 Base";
  if (net === "eip155:84532") return "🔷 Base Sepolia";
  if (net.startsWith("eip155:")) return `🔷 EVM (${net})`;
  if (net.startsWith("solana:")) return "◎ Solana";
  return net;
}

interface ToolResultCardProps {
  toolName: string;
  result: unknown;
}

export function ToolResultCard({ toolName, result }: ToolResultCardProps) {
  let data: any;
  try {
    data = typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    return null;
  }

  // ── Pending action cards ────────────────────────────────────────────────────

  // buy_bitrefill_product — invoice created, awaiting payment
  if (toolName === "buy_bitrefill_product" && data?.pendingBitrefillPayment) {
    // Resolve network icon/name from paymentMethod
    const pm: string = data.paymentMethod ?? (data.network === "solana" ? "usdc_solana" : "usdc_base");
    const PM_LABELS: Record<string, { icon: string; label: string }> = {
      usdc_base:     { icon: "🔷", label: "Base (USDC)" },
      usdc_solana:   { icon: "◎",  label: "Solana (USDC)" },
      usdc_erc20:    { icon: "⟠",  label: "Ethereum (USDC)" },
      usdc_polygon:  { icon: "🟣", label: "Polygon (USDC)" },
      usdc_arbitrum: { icon: "🔵", label: "Arbitrum (USDC)" },
      usdt_erc20:    { icon: "⟠",  label: "Ethereum (USDT)" },
      usdt_solana:   { icon: "◎",  label: "Solana (USDT)" },
      usdt_polygon:  { icon: "🟣", label: "Polygon (USDT)" },
      usdt_arbitrum: { icon: "🔵", label: "Arbitrum (USDT)" },
      usdt_bsc:      { icon: "🟡", label: "BNB Chain (USDT)" },
      usdc_bsc:      { icon: "🟡", label: "BNB Chain (USDC)" },
      bitcoin:       { icon: "₿",  label: "Bitcoin" },
      lightning:     { icon: "⚡", label: "Lightning" },
      litecoin:      { icon: "Ł",  label: "Litecoin" },
      dogecoin:      { icon: "Ð",  label: "Dogecoin" },
      ton:           { icon: "💎", label: "TON" },
      ethereum:      { icon: "⟠",  label: "Ethereum (ETH)" },
      solana:        { icon: "◎",  label: "Solana (SOL)" },
    };
    const pmMeta = PM_LABELS[pm] ?? { icon: "💳", label: pm };
    const isAddressBased = data.isAddressBased;
    const isLightning = pm === "lightning" || pm === "usdt_lightning";
    const isTopup = !!data.isTopup;

    return (
      <div className="my-2 rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-[#F2F0E8]">
            {pmMeta.icon} {pmMeta.label} · {data.paymentAmount ?? "?"} {data.paymentCurrency ?? ""}
          </p>
          {data.expiresInMinutes && (
            <span className="text-[10px] text-[#A7A79A]">Expires in {data.expiresInMinutes}m</span>
          )}
        </div>

        {isAddressBased ? (
          <>
            <p className="text-xs text-amber-400/90">
              ⚠ Send manually — this network isn&apos;t paid automatically.
            </p>
            <div className="rounded-lg bg-[#141513] px-3 py-2">
              <p className="text-[10px] text-[#A7A79A] mb-0.5">
                {isLightning ? "Lightning invoice" : "Deposit address"}
              </p>
              <p className="font-mono text-[10px] text-[#F2F0E8] break-all">{data.paymentAddress}</p>
            </div>
            <p className="text-[10px] text-[#A7A79A]">
              Send exactly <span className="text-[#F2F0E8] font-mono">{data.paymentAmount} {data.paymentCurrency}</span> to the address above.
            </p>
          </>
        ) : (
          <p className="text-xs text-[#A7A79A]">
            Confirm payment in the card below to complete your purchase.
          </p>
        )}

        {data.recipientEmail && (
          <p className="text-xs text-[#A7A79A]">
            {isTopup
              ? <>Receipt → <span className="text-[#F2F0E8]">{data.recipientEmail}</span> · airtime credited directly to the phone</>
              : <>Code → <span className="text-[#F2F0E8]">{data.recipientEmail}</span> · also shown here once confirmed</>
            }
          </p>
        )}
        <p className="font-mono text-[10px] text-[#A7A79A]">Invoice {data.invoiceId}</p>
      </div>
    );
  }

  // get_product_details — show product denominations so user can pick
  if (toolName === "get_product_details") {
    if (data?.error) {
      return (
        <div className="my-2 rounded-xl border border-red-700/30 bg-red-900/10 px-3 py-2">
          <p className="text-xs text-red-400">{data.error}</p>
        </div>
      );
    }
    const pkgs: Array<{ package_value: string; price_usd?: number }> = data?.packages ?? [];
    const range = data?.range as { min: number; max: number; step: number } | null;
    return (
      <div className="my-2 rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-[#F2F0E8] flex-1 truncate">{data?.name ?? data?.id}</p>
          {data?.recipient_type && (
            <span className="text-[10px] bg-white/[0.06] rounded px-1.5 py-0.5 text-[#A7A79A] capitalize">
              {String(data.recipient_type).replace(/_/g, " ")}
            </span>
          )}
        </div>
        {pkgs.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {pkgs.map((p) => (
              <span key={p.package_value}
                className="rounded-lg border border-[#2A2B27] px-2.5 py-1 text-[11px] text-[#F2F0E8]">
                {p.price_usd != null ? `$${p.price_usd}` : p.package_value}
              </span>
            ))}
          </div>
        ) : range ? (
          <p className="text-xs text-[#A7A79A]">
            Custom amount: ${range.min}–${range.max} (step ${range.step})
          </p>
        ) : null}
      </div>
    );
  }

  // poll_bitrefill_order — code ready, intermediate status, error, or still polling
  if (toolName === "poll_bitrefill_order") {
    if (data?.status === "complete" && data?.code) {
      return (
        <div className="my-2 rounded-xl border border-green-700/30 bg-green-900/10 px-4 py-3">
          <p className="text-xs font-semibold text-green-400 mb-2">
            {data.productName ?? "Digital product"} — Ready ✓
          </p>
          <div className="rounded-lg border border-green-700/20 bg-[#141513] px-3 py-2 mb-2">
            <p className="text-[10px] text-[#A7A79A] mb-1">Redemption Code</p>
            <p className="font-mono text-base font-bold tracking-widest text-[#8FAE82] break-all">
              {data.code}
            </p>
          </div>
          {data.esimInstallLink && (
            <a href={data.esimInstallLink} target="_blank" rel="noreferrer"
              className="text-xs text-[#8FAE82] underline">
              Install eSIM ↗
            </a>
          )}
          {data.instructions && (
            <p className="text-xs text-[#A7A79A] mt-1">{data.instructions}</p>
          )}
        </div>
      );
    }
    if (data?.status === "complete" && !data?.code) {
      // Delivered but no code (e.g. top-up applied directly)
      return (
        <div className="my-2 rounded-xl border border-green-700/30 bg-green-900/10 px-4 py-2">
          <p className="text-xs text-green-400">
            {data.productName ?? "Order"} delivered ✓ — {data.message ?? "No code required."}
          </p>
        </div>
      );
    }
    if (data?.status === "failed" || data?.status === "expired" || data?.status === "cancelled") {
      return (
        <div className="my-2 rounded-xl border border-red-700/30 bg-red-900/10 px-4 py-2">
          <p className="text-xs text-red-400">{data.error ?? `Payment ${data.status}. Please try again.`}</p>
        </div>
      );
    }
    // Intermediate statuses: payment_detected, payment_confirmed, pending
    const intermediateLabel: Record<string, string> = {
      payment_detected:  "Payment detected · awaiting confirmation…",
      payment_confirmed: "Payment confirmed · processing order…",
      pending:           "Processing your order…",
    };
    const label = intermediateLabel[data?.status] ?? "Waiting for payment confirmation…";
    return (
      <div className="my-2 rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 flex items-center gap-3">
        <div className="h-4 w-4 animate-spin rounded-full border border-[#8FAE82] border-t-transparent shrink-0" />
        <p className="text-xs text-[#A7A79A]">{label}</p>
      </div>
    );
  }

  if (toolName === "buy_investment" && data?.pendingPurchase) {
    return (
      <BuyAssetConfirmCard
        symbol={data.symbol}
        assetName={data.assetName}
        shares={data.shares}
        priceUsd={data.priceUsd}
        totalUsdc={data.totalUsdc}
        icon={data.icon}
        type={data.type}
        network={data.network}
      />
    );
  }

  // ── x402 / nanopay / solpay receipt cards ─────────────────────────────────

  if (toolName === "x402_pay") {
    const success = data?.success === true;
    const isSpendLimit = data?.error === "spend_limit_exceeded";
    const net = networkLabel(data?.network);
    const paidUsdc = data?.paid_usdc != null ? Number(data.paid_usdc) : null;
    const tx = data?.tx as string | null | undefined;

    if (isSpendLimit) {
      return (
        <div className="my-2 rounded-xl border border-yellow-700/30 bg-yellow-900/10 px-4 py-3">
          <p className="text-xs font-semibold text-yellow-400 mb-1">Payment blocked — spend limit exceeded</p>
          <p className="text-xs text-[#A7A79A]">
            Resource demands <span className="text-[#F2F0E8] font-mono">${fmtUsdc(Number(data.demanded_usdc))}</span> USDC
            · cap is <span className="font-mono">${fmtUsdc(Number(data.max_amount_usdc))}</span> USDC
          </p>
          <p className="mt-1 text-[10px] text-[#A7A79A]">Confirm with Bluvfi to raise the ceiling and retry.</p>
        </div>
      );
    }

    if (success) {
      return (
        <div className="my-2 rounded-xl border border-green-700/30 bg-green-900/10 px-4 py-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-semibold text-green-400">x402 Payment ✓</p>
            <p className="font-mono text-xs text-[#F2F0E8]">
              {paidUsdc != null ? `$${fmtUsdc(paidUsdc)} USDC` : ""}
            </p>
          </div>
          <p className="text-[10px] text-[#A7A79A]">{net}</p>
          {tx && (
            <p className="mt-1 font-mono text-[9px] text-[#A7A79A] truncate">tx: {tx}</p>
          )}
        </div>
      );
    }

    // Generic failure
    return (
      <div className="my-2 rounded-xl border border-red-700/30 bg-red-900/10 px-4 py-3">
        <p className="text-xs font-semibold text-red-400">x402 Payment failed</p>
        {data?.error && (
          <p className="mt-0.5 text-[10px] text-[#A7A79A]">{String(data.error).slice(0, 200)}</p>
        )}
        <p className="mt-0.5 text-[10px] text-[#A7A79A]">{net}</p>
      </div>
    );
  }

  if (toolName === "nanopay_pay") {
    const ok = data?.status === "success";
    return (
      <div className={`my-2 rounded-xl border px-4 py-3 ${ok ? "border-green-700/30 bg-green-900/10" : "border-red-700/30 bg-red-900/10"}`}>
        <div className="flex items-center justify-between">
          <p className={`text-xs font-semibold ${ok ? "text-green-400" : "text-red-400"}`}>
            {ok ? "EVM Nanopayment ✓" : "EVM Nanopayment failed"}
          </p>
          {data?.formattedAmount && (
            <p className="font-mono text-xs text-[#F2F0E8]">{data.formattedAmount}</p>
          )}
        </div>
        <p className="mt-0.5 text-[10px] text-[#A7A79A]">🔷 Base (EVM)</p>
        {!ok && data?.error && (
          <p className="mt-0.5 text-[10px] text-[#A7A79A]">{String(data.error).slice(0, 200)}</p>
        )}
      </div>
    );
  }

  if (toolName === "solpay_pay") {
    const ok = data?.paid === true;
    return (
      <div className={`my-2 rounded-xl border px-4 py-3 ${ok ? "border-green-700/30 bg-green-900/10" : "border-red-700/30 bg-red-900/10"}`}>
        <p className={`text-xs font-semibold ${ok ? "text-green-400" : "text-red-400"}`}>
          {ok ? "Solana Payment ✓" : "Solana Payment failed"}
        </p>
        <p className="mt-0.5 text-[10px] text-[#A7A79A]">◎ Solana (x402 / MPP)</p>
        {!ok && data?.error && (
          <p className="mt-0.5 text-[10px] text-[#A7A79A]">{String(data.error).slice(0, 200)}</p>
        )}
      </div>
    );
  }

  // ── SolPay seller gate results ──────────────────────────────────────────────

  const SOLPAY_SELLER_TOOLS = new Set([
    "solpay_sell_dynamic",
    "solpay_sell_subscription",
    "solpay_sell_usage",
    "solpay_sell_with_fee",
  ]);
  if (SOLPAY_SELLER_TOOLS.has(toolName)) {
    if (data?.status === "payment_required") {
      return (
        <div className="my-2 rounded-xl border border-yellow-700/30 bg-yellow-900/10 px-4 py-3">
          <p className="text-xs font-semibold text-yellow-400">◎ Payment Required (402)</p>
          <p className="mt-0.5 text-[10px] text-[#A7A79A]">
            Gate: {toolName.replace("solpay_", "").replace(/_/g, "-")} · Protocol:{" "}
            {data?.challenge?.protocol ?? "MPP/x402"}
          </p>
          {data?.challenge?.amount && (
            <p className="mt-0.5 text-[10px] text-[#A7A79A]">
              Amount: {data.challenge.amount} {data.challenge.currency ?? "USDC"}
            </p>
          )}
        </div>
      );
    }
    if (data?.content || data?.result || data?.paidBy) {
      return (
        <div className="my-2 rounded-xl border border-green-700/30 bg-green-900/10 px-4 py-3">
          <p className="text-xs font-semibold text-green-400">◎ SolPay Gate — Paid ✓</p>
          {data.paidBy && (
            <p className="mt-0.5 text-[10px] text-[#A7A79A]">Paid by: {String(data.paidBy).slice(0, 20)}…</p>
          )}
          {data.chargedUSDC && (
            <p className="mt-0.5 text-[10px] text-[#A7A79A]">Charged: ${data.chargedUSDC} USDC ({data.words} words)</p>
          )}
          {data.breakdown && (
            <p className="mt-0.5 text-[10px] text-[#A7A79A]">
              Total: {data.breakdown.total} · Seller: {data.breakdown.seller} · Fee: {data.breakdown.platformFee}
            </p>
          )}
        </div>
      );
    }
  }

  // ── Solana USDC transfer tx build result ─────────────────────────────────────

  if (toolName === "solana_transfer_usdc" && data?.transaction) {
    return (
      <div className="my-2 rounded-xl border border-[#9945FF]/30 bg-[#9945FF]/5 px-4 py-3">
        <p className="text-xs font-semibold text-[#9945FF]">◎ Solana USDC Transfer — Sign Required</p>
        <p className="mt-0.5 text-[10px] text-[#A7A79A]">
          Transaction built. Sign it with your Privy Solana wallet to broadcast.
        </p>
        <p className="mt-0.5 text-[10px] font-mono text-[#A7A79A] break-all">
          {String(data.transaction).slice(0, 40)}…
        </p>
      </div>
    );
  }

  // ── Data cards ──────────────────────────────────────────────────────────────

  if (toolName === "get_bills" && Array.isArray(data?.bills)) {
    return <BillsCard bills={data.bills} />;
  }

  if (
    (toolName === "get_investments" || toolName === "get_market_prices") &&
    Array.isArray(data?.assets)
  ) {
    return <AssetsCard assets={data.assets} />;
  }

  if (toolName === "get_payment_history" && Array.isArray(data?.payments)) {
    return <PaymentHistoryCard payments={data.payments} />;
  }

  // ── Legacy / other cards ────────────────────────────────────────────────────

  if (toolName === "get_vault_rates" && Array.isArray(data)) {
    return (
      <div className="my-2 space-y-1.5 rounded-xl border border-border/60 bg-cream-dark/30 px-4 py-3">
        <span className="label-mono text-[10px]">Current rates</span>
        {data.map((v: any) => (
          <div key={v.id} className="flex items-center justify-between">
            <span className="font-body text-xs text-ink">
              {VAULT_FRIENDLY_NAMES[v.id] || v.name}
            </span>
            <span className="rounded-md bg-sage/10 px-1.5 py-0.5 font-mono text-[10px] text-sage">
              {v.apy}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "get_user_positions" && Array.isArray(data)) {
    return (
      <div className="my-2 space-y-1.5 rounded-xl border border-border/60 bg-cream-dark/30 px-4 py-3">
        <span className="label-mono text-[10px]">Your savings</span>
        {data.map((p: any) => (
          <div key={p.vaultId} className="flex items-center justify-between">
            <div>
              <span className="font-body text-xs text-ink">{p.vaultName}</span>
              {p.apy && p.apy !== "N/A" && (
                <span className="ml-1.5 rounded-md bg-sage/10 px-1.5 py-0.5 font-mono text-[10px] text-sage">
                  {p.apy}
                </span>
              )}
            </div>
            <span className="font-mono text-xs text-ink">
              {p.deposited} {p.tokenSymbol}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "create_goal" && data?.success) {
    const goal = data.goal;
    return (
      <div className="my-2 space-y-1.5 rounded-xl border border-sage/20 bg-sage/5 px-4 py-3">
        <span className="label-mono text-[10px]">Goal set</span>
        <div className="flex items-center justify-between">
          <span className="font-body text-xs text-ink">{goal.name}</span>
          <span className="font-mono text-xs text-ink">
            {Number(goal.targetAmount).toLocaleString("en-US")} {goal.currency}
          </span>
        </div>
        <p className="font-mono text-[10px] text-ink-light">{goal.friendlyVault}</p>
      </div>
    );
  }

  if (toolName === "get_goals" && Array.isArray(data)) {
    return (
      <div className="my-2 space-y-1.5 rounded-xl border border-border/60 bg-cream-dark/30 px-4 py-3">
        <span className="label-mono text-[10px]">Your goals</span>
        {data.map((g: any) => (
          <div key={g.vaultId} className="flex items-center justify-between">
            <span className="font-body text-xs text-ink">{g.name}</span>
            <span className="font-mono text-xs text-ink">
              {Number(g.targetAmount).toLocaleString("en-US")} {g.currency}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "get_wallet_balance" && data && !data.error) {
    return (
      <div className="my-2 space-y-1.5 rounded-xl border border-border/60 bg-cream-dark/30 px-4 py-3">
        <span className="label-mono text-[10px]">Wallet balance</span>
        {data.tokens?.map((t: any, i: number) => (
          <div key={i} className="flex items-center justify-between">
            <span className="font-mono text-xs text-ink">{t.symbol}</span>
            <span className="font-mono text-xs text-ink-light">{t.balance}</span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  streaming: "Streaming",
  internet: "Internet",
  cable: "Cable",
  utility: "Utilities",
};

function BillsCard({ bills }: { bills: any[] }) {
  const { isBillPaid } = useDemoState();

  return (
    <div className="my-2 rounded-xl border border-border/60 bg-cream-dark/30 overflow-hidden">
      <div className="px-4 pt-3 pb-2">
        <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">
          Bills & Subscriptions
        </span>
      </div>
      <div className="divide-y divide-border/40">
        {bills.map((bill: any) => {
          const active = isBillPaid(bill.id);
          return (
            <div key={bill.id} className="flex items-center justify-between px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-body text-xs text-ink truncate">{bill.name}</span>
                  {active && (
                    <span className="shrink-0 rounded-full bg-sage/15 px-1.5 py-0.5 font-mono text-[9px] text-sage">
                      Active
                    </span>
                  )}
                </div>
                <span className="font-mono text-[10px] text-ink-light">
                  {CATEGORY_LABEL[bill.category] ?? bill.category}
                  {bill.dueDay ? ` · due the ${bill.dueDay}${ordinal(bill.dueDay)}` : ""}
                </span>
              </div>
              <span className="ml-3 shrink-0 font-mono text-xs text-ink">
                ${Number(bill.amount).toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AssetsCard({ assets }: { assets: any[] }) {
  return (
    <div className="my-2 rounded-xl border border-border/60 bg-cream-dark/30 overflow-hidden">
      <div className="px-4 pt-3 pb-2">
        <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">
          Market Prices
        </span>
      </div>
      <div className="divide-y divide-border/40">
        {assets.map((asset: any) => {
          const change = Number(asset.change24h ?? 0);
          const positive = change >= 0;
          return (
            <div key={asset.symbol} className="flex items-center justify-between px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-ink">{asset.symbol}</span>
                  <span className="rounded-full bg-border/60 px-1.5 py-0.5 font-mono text-[9px] text-ink-light capitalize">
                    {asset.type}
                  </span>
                </div>
                <span className="font-body text-[10px] text-ink-light truncate">{asset.name}</span>
              </div>
              <div className="ml-3 shrink-0 text-right">
                <p className="font-mono text-xs text-ink">${Number(asset.priceUsd).toFixed(2)}</p>
                {asset.change24h !== undefined && (
                  <p className={`font-mono text-[10px] ${positive ? "text-sage" : "text-fail"}`}>
                    {positive ? "+" : ""}{change.toFixed(2)}%
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PaymentHistoryCard({ payments }: { payments: any[] }) {
  if (payments.length === 0) {
    return (
      <div className="my-2 rounded-xl border border-border/60 bg-cream-dark/30 px-4 py-3">
        <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">
          Payment History
        </span>
        <p className="mt-2 font-body text-xs text-ink-light">No payments yet.</p>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-border/60 bg-cream-dark/30 overflow-hidden">
      <div className="px-4 pt-3 pb-2">
        <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">
          Payment History
        </span>
      </div>
      <div className="divide-y divide-border/40">
        {payments.map((p: any) => (
          <div key={p.id} className="flex items-center justify-between px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <span className="font-body text-xs text-ink truncate block">{p.description}</span>
              <span className="font-mono text-[10px] text-ink-light">
                {p.createdAt ? new Date(p.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
                {p.type ? ` · ${p.type}` : ""}
                {p.chain === "solana" ? " · ◎ Solana" : p.chain === "evm" ? " · 🔷 Base" : ""}
              </span>
            </div>
            <div className="ml-3 shrink-0 text-right">
              <p className="font-mono text-xs text-ink">${fmtUsdc(Number(p.amountUsdc))}</p>
              {p.status && (
                <p className={`font-mono text-[9px] ${p.status === "confirmed" ? "text-sage" : "text-ink-light"}`}>
                  {p.status}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0];
}
