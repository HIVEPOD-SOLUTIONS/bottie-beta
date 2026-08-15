"use client";

import { useState, useEffect } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useChatSheet } from "@/contexts/chat-context";
import { useDemoState } from "@/contexts/demo-state-context";
import { BillsScreen } from "@/components/dashboard/bills-screen";
import { PaymentsScreen } from "@/components/dashboard/payments-screen";
import { PaymentsProvider, usePaymentsContext } from "@/contexts/payments-context";

function ComingSoon({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.06] text-3xl">
        {icon}
      </div>
      <div>
        <p className="text-lg font-semibold text-[#F2F0E8]">{title} — Coming Soon</p>
        <p className="mt-1.5 max-w-xs text-sm text-[#A7A79A] leading-relaxed">{description}</p>
      </div>
      <span className="mt-2 rounded-full border border-[#8FAE82]/40 bg-[#8FAE82]/10 px-4 py-1.5 text-xs font-medium text-[#8FAE82]">
        In development
      </span>
    </div>
  );
}
import { FundWalletSheet } from "@/components/dashboard/fund-wallet-sheet";
import { LOW_BALANCE_THRESHOLD_USD } from "@/hooks/use-usdc-balance";
import { useStablecoinBalances } from "@/hooks/use-stablecoin-balances";
import { ASSET_PRICES } from "@/lib/demo-data";
import { getPrivyEmbeddedWallets } from "@/lib/privy-wallets";
import { getUserFirstName, getTimeBasedGreeting } from "@/lib/user-display-name";

type Tab = "bills" | "investments" | "payments" | "banking" | "chat";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "bills",       label: "Bills",   icon: "🧾" },
  { key: "investments", label: "Invest",  icon: "📈" },
  { key: "banking",     label: "Banking", icon: "🏦" },
  { key: "payments",    label: "History", icon: "💳" },
  { key: "chat",        label: "Chat",    icon: "💬" },
];

function DashboardInner() {
  const { openSidebar, open: openChat, registerDashboardData } = useChatSheet();
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const [activeTab, setActiveTab] = useState<Tab>("bills");
  const [showFundSheet, setShowFundSheet] = useState(false);
  const { paidBillIds, portfolio } = useDemoState();

  const { evmAddress, solanaAddress: solanaAddr, smartWalletAddress } = getPrivyEmbeddedWallets(user as any, wallets);
  // Prefer smart-wallet address; fall back to embedded wallet. Matches settings-sidebar.tsx.
  const agentAddress = (smartWalletAddress ?? evmAddress) as `0x${string}` | undefined;

  // All four stablecoin balances — drives sidebar rows, dashboard totals, and the banner
  const {
    evmUsdc,
    evmUsdt,
    solUsdc,
    solUsdt,
    isLoading: sbLoading,
  } = useStablecoinBalances();

  // Total across all networks and tokens — used for the low-balance banner.
  // Note: totalBalance > 0 guard removed — a zero or near-zero balance is the most
  // important case to warn about. The isLoading gate (sbLoading=true on first render)
  // already prevents a false-positive flash before the first fetch completes.
  const totalBalance = evmUsdc + evmUsdt + solUsdc + solUsdt;
  const balanceIsLow = !sbLoading && totalBalance < LOW_BALANCE_THRESHOLD_USD;
  const balanceFormatted = `$${totalBalance.toFixed(2)}`;
  const firstName = getUserFirstName(user);
  const greeting = getTimeBasedGreeting();

  const handleTabClick = (tab: Tab) => {
    if (tab === "chat") {
      openChat();
    } else {
      setActiveTab(tab);
    }
  };

  // monthlyBills tracks only purchases recorded in the session
  const monthlyBills = paidBillIds.length * 0; // placeholder — real amounts tracked in payments history

  const portfolioValue = portfolio.reduce(
    (sum, p) => sum + p.shares * (ASSET_PRICES[p.symbol] ?? p.avgPriceUsd),
    0
  );

  // Pull completed bill count from DB — includes AI-initiated purchases,
  // not just ones made through the Bills UI (which paidBillIds tracks).
  const { billPayments } = usePaymentsContext();
  const dbBillCount = billPayments.filter((p) => p.status === "completed").length;
  const purchasedCount = Math.max(paidBillIds.length, dbBillCount);

  // Keep the AI agent's financial context in sync with the live dashboard values.
  // registerDashboardData writes to a ref so this never triggers re-renders in ChatSheet.
  // Balance fields (evmUsdc etc.) are included so chat-sheet reads from here instead of
  // running its own independent useStablecoinBalances() fetch.
  // Only register balance data once the stablecoin fetch has completed.
  // This prevents the AI from seeing $0 balances during the loading phase.
  useEffect(() => {
    if (sbLoading) return;
    registerDashboardData({
      totalBillsDueUsd: monthlyBills,
      portfolioValueUsd: portfolioValue,
      billCount: purchasedCount,
      evmUsdc,
      evmUsdt,
      solUsdc,
      solUsdt,
    });
  }, [sbLoading, monthlyBills, portfolioValue, purchasedCount, evmUsdc, evmUsdt, solUsdc, solUsdt, registerDashboardData]);

  return (
    <div className="relative min-h-dvh">
      {/* Header */}
      <div className="fixed top-0 right-0 left-0 z-30 flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),12px)] pb-3 bg-cream-dark/80 backdrop-blur-sm">
        <button
          onClick={openSidebar}
          className="rounded-full p-2 transition-colors duration-200 hover:bg-ink/[0.04]"
          aria-label="Open settings"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-ink-light">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        <div className="text-center">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-light/50 uppercase tracking-wide">
            Bluvfi
            <span className="rounded text-[9px] font-bold tracking-wide uppercase bg-violet-500/20 text-violet-400 px-1 py-px leading-none normal-case">beta</span>
          </p>
        </div>

        <button
          onClick={() => openChat()}
          className="rounded-full p-2 transition-colors duration-200 hover:bg-ink/[0.04]"
          aria-label="Open chat"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-ink-light">
            <path
              d="M18 10c0 4.418-3.582 8-8 8a7.96 7.96 0 01-4-.107L2 19l1.107-4A7.96 7.96 0 012 10C2 5.582 5.582 2 10 2s8 3.582 8 8z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* Low-balance banner */}
      {balanceIsLow && agentAddress && (
        <div className="fixed top-[calc(env(safe-area-inset-top)+56px)] left-0 right-0 z-20 mx-5 mt-1">
          <div className="flex items-center justify-between rounded-xl bg-amber-900/30 border border-amber-700/40 px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm text-amber-400">
              <span>⚠</span>
              <span className="font-medium">
                Low balance ({balanceFormatted}) — payments may fail
              </span>
            </div>
            <button
              onClick={() => setShowFundSheet(true)}
              className="shrink-0 rounded-lg bg-amber-400 px-3 py-1 text-xs font-semibold text-[#141513]"
            >
              Add Funds
            </button>
          </div>
        </div>
      )}

      {/* Summary strip */}
      <div
        className={`px-5 pb-2 pt-2 ${
          balanceIsLow && agentAddress
            ? "mt-[calc(env(safe-area-inset-top)+100px)]"
            : "mt-[calc(env(safe-area-inset-top)+56px)]"
        }`}
      >
        <p className="mb-3 text-lg font-semibold text-[#F2F0E8]">
          {greeting}{firstName ? `, ${firstName}` : ""} 👋
        </p>

        <div className="flex gap-3">
          {/* Digital Products card */}
          <div className="flex-1 rounded-2xl bg-[#1B1C19] border border-[#2A2B27] p-4">
            <p className="text-xs text-[#A7A79A] font-medium">Digital Products</p>
            <p className="text-xl font-bold text-[#F2F0E8] mt-0.5">
              {purchasedCount}
            </p>
            <p className="text-xs text-[#8FAE82] mt-0.5">purchased</p>
          </div>

          {/* Portfolio card */}
          <div className="flex-1 rounded-2xl bg-[#1B1C19] border border-[#2A2B27] p-4">
            <p className="text-xs text-[#A7A79A] font-medium">Portfolio</p>
            <p className="text-xl font-bold text-[#F2F0E8] mt-0.5">
              ${portfolioValue.toFixed(2)}
            </p>
            <p className="text-xs text-green-400 mt-0.5">
              {portfolio.length} position{portfolio.length !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Wallet balance card */}
          {agentAddress && (
            <div
              className="w-[116px] shrink-0 cursor-pointer rounded-2xl border p-3 flex flex-col gap-2 transition-colors hover:border-[#8FAE82]/50"
              style={{
                background: "#1B1C19",
                borderColor: balanceIsLow ? "rgba(251,191,36,0.4)" : "#2A2B27",
              }}
              onClick={() => setShowFundSheet(true)}
            >
              <p className="text-[10px] text-[#A7A79A] font-medium leading-tight">Wallets</p>

              {/* EVM total — USDC + USDT across all EVM chains */}
              <div className="flex items-baseline justify-between gap-1">
                <span className="text-[9px] text-[#A7A79A] leading-tight font-medium">EVM</span>
                <span
                  className="text-xs font-bold leading-tight tabular-nums"
                  style={{ color: balanceIsLow ? "#fbbf24" : "#F2F0E8" }}
                >
                  {sbLoading ? "…" : `$${(evmUsdc + evmUsdt).toFixed(2)}`}
                </span>
              </div>

              {/* Solana total — USDC + USDT on Solana */}
              {solanaAddr && (
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-[9px] text-[#A7A79A] leading-tight font-medium">Solana</span>
                  <span className="text-xs font-bold leading-tight tabular-nums text-[#F2F0E8]">
                    {sbLoading ? "…" : `$${(solUsdc + solUsdt).toFixed(2)}`}
                  </span>
                </div>
              )}

              <p className="text-[10px] text-[#8FAE82]">+ Add</p>
            </div>
          )}
        </div>
      </div>

      {/* Tab navigation — sticks BELOW the low-balance banner when it is visible */}
      <div className={`sticky ${
        balanceIsLow && agentAddress
          ? "top-[calc(env(safe-area-inset-top)+100px)]"
          : "top-[calc(env(safe-area-inset-top)+56px)]"
      } z-20 flex gap-1 bg-cream-dark/90 backdrop-blur-sm px-5 py-2 border-b border-[#2A2B27]`}>
        {TABS.filter((t) => t.key !== "chat").map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabClick(tab.key)}
            className={`flex-1 flex flex-col items-center gap-0.5 rounded-xl py-2 transition-colors ${
              activeTab === tab.key
                ? "bg-[#F2F0E8] text-[#141513]"
                : "text-[#A7A79A] hover:bg-white/[0.04]"
            }`}
          >
            <span className="text-base">{tab.icon}</span>
            <span className="text-[10px] font-medium">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="px-5 py-4">
        {activeTab === "bills"       && <BillsScreen />}
        {activeTab === "investments" && <ComingSoon icon="📈" title="Invest" description="Stock, ETF & pre-IPO investing is on its way. You'll be able to build your portfolio right here." />}
        {activeTab === "banking"     && <ComingSoon icon="🏦" title="Banking" description="Onramp, offramp, payouts & stablecoin banking are coming soon. Global fiat ↔ crypto rails, all in one place." />}
        {activeTab === "payments"    && <PaymentsScreen />}
      </div>

      {/* Fund wallet sheet */}
      {showFundSheet && agentAddress && (
        <FundWalletSheet
          agentAddress={agentAddress}
          solanaAddress={solanaAddr}
          onClose={() => setShowFundSheet(false)}
        />
      )}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <PaymentsProvider>
      <DashboardInner />
    </PaymentsProvider>
  );
}
