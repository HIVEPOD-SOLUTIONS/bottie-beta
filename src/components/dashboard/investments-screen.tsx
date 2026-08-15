"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useChatSheet } from "@/contexts/chat-context";
import { useInvestments, type InvestmentPosition } from "@/hooks/use-investments";
import { VelvetTradingSection } from "./velvet-trading-section";
import { FlashTradeSection } from "./flash-trade-section";
import { FlashExtrasSection } from "./flash-extras-section";
import { GrailSection } from "./grail-section";
import { RoasterSection } from "./roaster-section";
import { NosanaSection } from "./nosana-section";
import { DomaSection } from "./doma-section";
import { XStocksSection } from "./xstocks-section";
import { DydxSection } from "./dydx-section";

const MARKET_TABS = [
  { key: "all",    label: "All"            },
  { key: "stock",  label: "Stocks"         },
  { key: "ipo",    label: "Pre-IPO"        },
  { key: "etf",    label: "ETFs"           },
  { key: "crypto", label: "Crypto Trading" },
] as const;

function PortfolioCard({ pos }: { pos: InvestmentPosition }) {
  const isPos = pos.gainLossUsd >= 0;

  return (
    <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.06] text-xl">
            {pos.icon}
          </div>
          <div>
            <p className="font-semibold text-[#F2F0E8]">{pos.symbol}</p>
            <p className="text-xs text-[#A7A79A]">{pos.name}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="font-semibold text-[#F2F0E8]">${pos.currentValueUsd.toFixed(2)}</p>
          <p className={`text-xs font-medium ${isPos ? "text-green-400" : "text-red-400"}`}>
            {isPos ? "+" : ""}${pos.gainLossUsd.toFixed(2)}
            {" "}
            <span className="opacity-70">({isPos ? "+" : ""}{pos.gainLossPct.toFixed(1)}%)</span>
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-4 text-xs text-[#A7A79A]">
        <span>{pos.shares.toFixed(4)} shares</span>
        <span>avg ${pos.avgPriceUsd.toFixed(2)}</span>
        <span>now ${pos.currentPriceUsd.toFixed(2)}</span>
      </div>
    </div>
  );
}


// ── xStocks platform card (shown in Stocks tab) ───────────────────────────────

function XStocksBanner({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-4 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-left hover:border-[#3A3B37] transition-colors w-full"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl overflow-hidden bg-[#0D1B1A]">
        <img src="/tokens/xstocks-icon.svg" alt="xStocks" className="h-10 w-10" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <img src="/tokens/xstocks.svg" alt="xStocks" className="h-4" style={{ width: "auto" }} />
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-[#A7A79A]">Tokenized Stocks</span>
          <span className="rounded-full px-2 py-0.5 text-xs font-medium text-teal-400 bg-teal-400/10">Backed</span>
        </div>
        <p className="truncate text-xs text-[#A7A79A] mt-0.5">
          AAPL, TSLA, NVDA and 70+ tokenized real-world stocks on-chain — xChange RFQ, proof of reserves, oracles
        </p>
      </div>
      <svg className="shrink-0 text-[#A7A79A]" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  );
}

// ── Crypto platform list + detail sheet ──────────────────────────────────────

type CryptoPlatform = "flash-trade" | "flash-extras" | "velvet" | "grail" | "roaster" | "nosana" | "doma" | "dydx";

const CRYPTO_PLATFORMS = [
  {
    id: "flash-trade" as CryptoPlatform,
    icon: "⚡",
    name: "Flash Trade",
    tag: "Perpetuals",
    description: "Up to 100× leverage on SOL, BTC, ETH and more — Solana mainnet",
    badge: "Solana",
    badgeColor: "text-purple-400 bg-purple-400/10",
  },
  {
    id: "flash-extras" as CryptoPlatform,
    icon: "🔄",
    name: "Flash Swap & Earn",
    tag: "DeFi",
    description: "Swap tokens, provide FLP/sFLP liquidity, stake FLASH, collect rebates",
    badge: "Solana",
    badgeColor: "text-purple-400 bg-purple-400/10",
  },
  {
    id: "velvet" as CryptoPlatform,
    icon: "🏦",
    name: "Velvet Vaults",
    tag: "On-chain Vaults",
    description: "Automated on-chain vaults — deposit, withdraw and rebalance on Base",
    badge: "Base",
    badgeColor: "text-blue-400 bg-blue-400/10",
  },
  {
    id: "grail" as CryptoPlatform,
    icon: "✦",
    name: "Oro Gold",
    tag: "Physical Gold",
    description: "Buy, sell, and redeem physical gold on Solana via $GOLD tokens",
    badge: "Solana",
    badgeColor: "text-yellow-400 bg-yellow-400/10",
  },
  {
    id: "roaster" as CryptoPlatform,
    icon: "🎤",
    name: "Roaster",
    tag: "AI Rap Battles",
    description: "Back a side in AI rap battles — AI Jury picks the winner, you split the pool",
    badge: "Solana",
    badgeColor: "text-purple-400 bg-purple-400/10",
  },
  {
    id: "nosana" as CryptoPlatform,
    icon: "⚙️",
    name: "Nosana GPU Cloud",
    tag: "AI Compute",
    description: "Deploy containerized AI workloads on decentralized GPUs — pay with NOS credits",
    badge: "Solana",
    badgeColor: "text-purple-400 bg-purple-400/10",
  },
  {
    id: "doma" as CryptoPlatform,
    icon: "⌁",
    name: "Doma Protocol",
    tag: "DomainFi",
    description: "Search, analyze, and prepare trades for tokenized internet domains",
    badge: "Doma",
    badgeColor: "text-cyan-400 bg-cyan-400/10",
  },
  {
    id: "dydx" as CryptoPlatform,
    icon: "⚡",
    name: "dYdX Chain",
    tag: "Perpetuals",
    description: "Up to 100× leverage on BTC, ETH, SOL and 100+ markets — Cosmos appchain, no gas fees",
    badge: "Cosmos",
    badgeColor: "text-purple-400 bg-purple-400/10",
  },
];

function CryptoList() {
  const [open, setOpen] = useState<CryptoPlatform | null>(null);

  return (
    <>
      <div className="flex flex-col gap-3">
        {CRYPTO_PLATFORMS.map((p) => (
          <button
            key={p.id}
            onClick={() => setOpen(p.id)}
            className="flex items-center gap-4 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-left transition-colors hover:border-[#3A3B37] active:bg-white/[0.04] w-full"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-2xl">
              {p.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-[#F2F0E8]">{p.name}</p>
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-[#A7A79A]">{p.tag}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.badgeColor}`}>{p.badge}</span>
              </div>
              <p className="truncate text-xs text-[#A7A79A] mt-0.5">{p.description}</p>
            </div>
            <svg className="shrink-0 text-[#A7A79A]" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        ))}
      </div>

      {/* Detail sheet — slides up over the page */}
      {open && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[70] flex flex-col">
          {/* Backdrop */}
          <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(null)} />
          {/* Sheet */}
          <div className="bg-[#141513] rounded-t-3xl max-h-[90vh] flex flex-col">
            {/* Handle + header */}
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[#2A2B27] shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-xl">
                  {CRYPTO_PLATFORMS.find(p => p.id === open)?.icon}
                </span>
                <div>
                  <p className="font-semibold text-[#F2F0E8] text-sm">
                    {CRYPTO_PLATFORMS.find(p => p.id === open)?.name}
                  </p>
                  <p className="text-xs text-[#A7A79A]">
                    {CRYPTO_PLATFORMS.find(p => p.id === open)?.tag}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setOpen(null)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-[#A7A79A] hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            {/* Scrollable content — padded so chat bar doesn't overlap */}
            <div className="overflow-y-auto flex-1 p-4 pb-[calc(max(env(safe-area-inset-bottom),24px)+72px)]">
              {open === "flash-trade"  && <FlashTradeSection />}
              {open === "flash-extras" && <FlashExtrasSection />}
              {open === "velvet"       && <VelvetTradingSection />}
              {open === "grail"        && <GrailSection />}
              {open === "roaster"     && <RoasterSection />}
              {open === "nosana"      && <NosanaSection />}
              {open === "doma"        && <DomaSection />}
              {open === "dydx"        && <DydxSection />}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export function InvestmentsScreen() {
  const { portfolio, totalValueUsd, loading: portfolioLoading, error: portfolioError, refetch } = useInvestments();
  const { open: openChat, sendMessage } = useChatSheet();
  const [viewTab, setViewTab] = useState<"portfolio" | "market">("portfolio");
  const [marketFilter, setMarketFilter] = useState<string>("all");
  const [xstocksOpen, setXstocksOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* Summary card */}
      <div className="rounded-3xl bg-[#8FAE82] p-5">
        <p className="text-sm font-medium text-[#141513]/70">Portfolio Value</p>
        <p className="mt-1 text-3xl font-bold text-[#141513]">
          ${totalValueUsd.toFixed(2)}
        </p>
        <p className="mt-0.5 text-xs text-[#141513]/50">
          {portfolio.length} position{portfolio.length !== 1 ? "s" : ""}
        </p>
        <button
          onClick={() => {
            sendMessage("What should I invest in? Show me my portfolio.");
            openChat();
          }}
          className="mt-4 rounded-xl bg-[#141513]/20 px-4 py-2 text-sm font-semibold text-[#141513]"
        >
          Ask AI for advice
        </button>
      </div>

      {/* View toggle */}
      <div className="flex gap-2">
        {(["portfolio", "market"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setViewTab(tab)}
            className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
              viewTab === tab
                ? "bg-[#F2F0E8] text-[#141513]"
                : "bg-white/[0.06] text-[#A7A79A]"
            }`}
          >
            {tab === "portfolio" ? "My Portfolio" : "Market"}
          </button>
        ))}
      </div>

      {/* Portfolio view */}
      {viewTab === "portfolio" && (
        <>
          {portfolioLoading && (
            <div className="flex flex-col gap-3 animate-pulse">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-20 rounded-2xl bg-white/[0.04]" />
              ))}
            </div>
          )}

          {portfolioError && (
            <div className="rounded-2xl border border-red-900/30 bg-red-900/10 px-4 py-3 text-sm text-red-400">
              {portfolioError}
              <button onClick={refetch} className="ml-3 underline text-xs">Retry</button>
            </div>
          )}

          {!portfolioLoading && !portfolioError && portfolio.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-4xl">📊</p>
              <p className="mt-2 font-semibold text-[#F2F0E8]">No positions yet</p>
              <p className="mt-1 text-sm text-[#A7A79A]">
                Browse the market to start investing
              </p>
              <button
                onClick={() => setViewTab("market")}
                className="mt-4 rounded-2xl bg-[#8FAE82] px-6 py-2.5 text-sm font-semibold text-[#141513]"
              >
                Browse Market
              </button>
            </div>
          ) : !portfolioLoading && portfolio.length > 0 ? (
            <div className="flex flex-col gap-3">
              {portfolio.map((pos) => (
                <PortfolioCard key={pos.id} pos={pos} />
              ))}
            </div>
          ) : null}
        </>
      )}

      {/* Market view */}
      {viewTab === "market" && (
        <>
          {/* Type filter tabs */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {MARKET_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setMarketFilter(tab.key)}
                className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  marketFilter === tab.key
                    ? "bg-[#F2F0E8] text-[#141513]"
                    : "bg-white/[0.06] text-[#A7A79A]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {(marketFilter === "stock" || marketFilter === "all") && (
            <XStocksBanner onOpen={() => setXstocksOpen(true)} />
          )}

          {(marketFilter === "ipo") && (
            <div className="py-12 text-center">
              <p className="text-4xl">🚀</p>
              <p className="mt-2 font-semibold text-[#F2F0E8]">Pre-IPO coming soon</p>
              <p className="mt-1 text-sm text-[#A7A79A]">Early-stage company investments will appear here</p>
            </div>
          )}

          {(marketFilter === "etf") && (
            <div className="py-12 text-center">
              <p className="text-4xl">📊</p>
              <p className="mt-2 font-semibold text-[#F2F0E8]">ETFs coming soon</p>
              <p className="mt-1 text-sm text-[#A7A79A]">Index and thematic ETFs will appear here</p>
            </div>
          )}

          {(marketFilter === "crypto" || marketFilter === "all") && (
            <CryptoList />
          )}
        </>
      )}

      {xstocksOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[70] flex flex-col">
          <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={() => setXstocksOpen(false)} />
          <div className="bg-[#141513] rounded-t-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[#2A2B27] shrink-0">
              <div className="flex items-center gap-3">
                <img src="/tokens/xstocks-icon.svg" alt="xStocks" className="h-8 w-8 rounded-lg bg-[#0D1B1A] p-0.5" />
                <div>
                  <p className="font-semibold text-[#F2F0E8] text-sm">xStocks</p>
                  <p className="text-xs text-[#A7A79A]">Tokenized Stocks</p>
                </div>
              </div>
              <button
                onClick={() => setXstocksOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-[#A7A79A] hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 pb-[calc(max(env(safe-area-inset-bottom),24px)+72px)]">
              <XStocksSection />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
