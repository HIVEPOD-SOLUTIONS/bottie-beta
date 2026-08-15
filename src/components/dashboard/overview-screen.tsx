"use client";

import { useMemo, useRef, useState, useCallback, useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { motion, AnimatePresence } from "framer-motion";
import type { VaultStatsItem } from "@yo-protocol/core";
import type { DashboardData } from "@/hooks/use-dashboard-data";
import { useChatSheet } from "@/contexts/chat-context";
import { useAppGoals } from "@/contexts/goals-context";
import { formatUsd, formatApy } from "@/lib/format";
import { VAULT_LOGOS, VAULT_FRIENDLY_NAMES, TOKEN_LOGOS } from "@/lib/constants";
import { OdometerNumber } from "@/components/ui/odometer-number";
import { PositionCard } from "./position-card";
import { GoalCard } from "./goal-card";
import { VaultCard } from "./vault-card";
import { ActivityList, type ActivityItem } from "./activity-list";
import { AddGoalSheet } from "./add-goal-sheet";

interface OverviewScreenProps {
  data: DashboardData;
  activities?: ActivityItem[];
  goals?: Record<string, { name: string; targetUsd: number }>;
  onVaultTap: (vault: VaultStatsItem) => void;
  onPositionTap: (vault: VaultStatsItem) => void;
  onRefresh?: () => Promise<void>;
  onAddFunds?: () => void;
  onSend?: () => void;
  onReceive?: () => void;
}

/* ── Daily hash for rotating content ─────────────────────── */

function hashOfDay(): number {
  const s = new Date().toDateString();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* ── Rich greeting with varied emojis ────────────────────── */

const GREETINGS: Record<string, [string, string][]> = {
  morning: [["Rise and shine", "☀️"], ["Good morning", "👋"], ["Morning", "☀️"]],
  afternoon: [["Good afternoon", "👋"], ["Hey there", "✨"], ["Afternoon", "🌤️"]],
  evening: [["Good evening", "🌙"], ["Evening", "👋"], ["Welcome back", "✨"]],
  night: [["Late night savings?", "🦉"], ["Still going", "🌙"], ["Hey", "👋"]],
};
const DAY_OVERRIDES: Record<number, [string, string][]> = {
  1: [["Start the week right", "💪"]], // Monday
  5: [["Happy Friday", "🎉"]],        // Friday
};
const EMOJI_ANIMS: Record<string, string> = {
  "👋": "origin-[70%_70%] animate-[wave-loop_8s_ease-in-out_infinite]",
  "☀️": "origin-center animate-[sun-loop_9s_ease-in-out_infinite]",
  "✨": "origin-center animate-[pulse_2s_ease-in-out_infinite]",
  "🌤️": "origin-center animate-[pulse_3s_ease-in-out_infinite]",
  "🌙": "origin-center animate-[pulse_4s_ease-in-out_infinite]",
  "🦉": "origin-center animate-[bounce_2s_ease-in-out_infinite]",
  "🎉": "origin-center animate-[bounce_1.5s_ease-in-out_infinite]",
  "💪": "origin-center animate-[pulse_2s_ease-in-out_infinite]",
};

function getGreeting(): { text: string; emoji: string; anim: string } {
  const now = new Date();
  const h = now.getHours();
  const day = now.getDay();
  const hash = hashOfDay();

  // Day override (20% chance)
  if (DAY_OVERRIDES[day] && hash % 5 === 0) {
    const opts = DAY_OVERRIDES[day];
    const [text, emoji] = opts[hash % opts.length];
    return { text, emoji, anim: EMOJI_ANIMS[emoji] || "" };
  }

  const period = h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
  const opts = GREETINGS[period];
  const [text, emoji] = opts[hash % opts.length];
  return { text, emoji, anim: EMOJI_ANIMS[emoji] || "" };
}

/* ── Editorial prose ─────────────────────────────────────── */

function getProse(hasPositions: boolean, apy: number, totalSavings: number, walletBalance: number): string {
  const hash = hashOfDay();
  if (hasPositions && apy > 0) {
    const daily = formatUsd((totalSavings * apy) / 100 / 365);
    const mult = Math.round(apy / 0.5);
    const lines = [
      `Your money is earning ${formatApy(String(apy))} annually \u2014 that\u2019s roughly ${daily} every day while you sleep.`,
      `Your savings are growing at ${formatApy(String(apy))}. Not bad for doing nothing.`,
      `Earning ${formatApy(String(apy))} on your savings. Zero fees, zero effort. That\u2019s ${mult}x a typical savings account.`,
    ];
    return lines[hash % lines.length];
  }
  if (walletBalance > 0) {
    const lines = [
      `You\u2019ve got ${formatUsd(walletBalance)} sitting idle. It could be earning up to ${apy > 0 ? formatApy(String(apy)) : "5.0%"}.`,
      `Most people leave their money sitting still. You don\u2019t have to.`,
      `Same money, better returns. No lock-ups, no fees.`,
    ];
    return lines[hash % lines.length];
  }
  const lines = [
    "This is where your savings story begins.",
    "Ready to start earning? It only takes a few seconds.",
  ];
  return lines[hash % lines.length];
}

/* ── Vault display labels ────────────────────────────────── */

const VAULT_SHORT: Record<string, string> = {
  yoUSD: "USD",
  yoETH: "ETH",
  yoBTC: "BTC",
  yoEUR: "EUR",
  yoGOLD: "Gold",
  yoUSDT: "USDT",
};

/* ── Staggered cascade animations ─────────────────────────── */

const ease = [0.16, 1, 0.3, 1] as const;
const cascade = (delay: number) => ({
  initial: { opacity: 0, y: 24 } as const,
  animate: { opacity: 1, y: 0 } as const,
  transition: { duration: 0.6, delay: delay / 1000, ease },
});

const greetReveal = cascade(0);
const deckReveal = cascade(80);
const proseReveal = cascade(180);
const sectionReveal = (i: number) => cascade(280 + i * 100);
const chipsReveal = cascade(550);

/* ── Narration text highlighting ──────────────────────────── */

const HIGHLIGHT_TOKENS = ["ETH", "WETH", "USDC", "USDT", "cbBTC", "BTC", "EURC", "EUR", "USD", "Gold"];
const HIGHLIGHT_VAULTS = Object.values(VAULT_FRIENDLY_NAMES);
const HIGHLIGHT_PATTERN = (() => {
  const vaultEscaped = HIGHLIGHT_VAULTS.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const tokensSorted = [...HIGHLIGHT_TOKENS].sort((a, b) => b.length - a.length);
  return new RegExp(
    `(\\$[\\d,.]+|\\d+\\.\\d{2,}|\\b(?:${vaultEscaped.join("|")})|\\b(?:${tokensSorted.join("|")})\\b)`,
    "gi",
  );
})();

function highlightNarration(text: string): React.ReactNode[] {
  const pattern = new RegExp(HIGHLIGHT_PATTERN.source, HIGHLIGHT_PATTERN.flags);

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const m = match[0];
    const isAmount = /^\$|^\d+\.\d{2,}$/.test(m);
    parts.push(
      <span
        key={match.index}
        className={
          isAmount
            ? "font-display underline decoration-sage/30 decoration-[1.5px] underline-offset-4"
            : "font-display"
        }
      >
        {m}
      </span>,
    );
    lastIndex = pattern.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

/* ── Card grain overlay ──────────────────────────────────── */

function CardGrain() {
  return (
    <div
      className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-[0.03] mix-blend-multiply"
      style={{ backgroundImage: "url(/noise.svg)", backgroundSize: "200px 200px" }}
    />
  );
}

/* ── Wallet icon ─────────────────────────────────────────── */

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="2" y="6" width="20" height="14" rx="3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 10h20" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="17" cy="14.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

/* ── Component ────────────────────────────────────────────── */

export function OverviewScreen({
  data,
  activities,
  goals,
  onVaultTap,
  onPositionTap,
  onRefresh,
  onAddFunds,
  onSend,
  onReceive,
}: OverviewScreenProps) {
  const { user } = usePrivy();
  const { open } = useChatSheet();
  const { refetch: refetchGoals } = useAppGoals();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeCard, setActiveCard] = useState(0);
  const [flippedCard, setFlippedCard] = useState<number | null>(null);
  const [addGoalVault, setAddGoalVault] = useState<VaultStatsItem | null>(null);

  const handleRemoveGoal = useCallback(async (vaultId: string) => {
    await fetch(`/api/goals?vaultId=${encodeURIComponent(vaultId)}`, { method: "DELETE" });
    await refetchGoals();
  }, [refetchGoals]);
  const [activityMode, setActivityMode] = useState<"prose" | "list">("prose");
  const [narration, setNarration] = useState<string | null>(null);
  const [narrationLoading, setNarrationLoading] = useState(false);

  // Pull-to-refresh
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const touchStartY = useRef(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.scrollY === 0 && !refreshing) {
      touchStartY.current = e.touches[0].clientY;
    }
  }, [refreshing]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === 0 || refreshing) return;
    const delta = e.touches[0].clientY - touchStartY.current;
    if (delta > 0) setPullDistance(Math.min(delta * 0.4, 100));
  }, [refreshing]);

  const handleTouchEnd = useCallback(async () => {
    if (pullDistance > 60 && onRefresh) {
      setRefreshing(true);
      try { await onRefresh(); } catch {}
      setRefreshing(false);
    }
    setPullDistance(0);
    touchStartY.current = 0;
  }, [pullDistance, onRefresh]);

  // Cache-aware display values
  const displaySavings = data.userLoading
    ? (data.cache?.totalSavingsUsd ?? null)
    : data.totalSavingsUsd;

  const displayBalance = data.userLoading
    ? (data.cache?.walletBalanceUsd ?? null)
    : data.walletBalanceUsd;

  const displayVaultIds = data.userLoading
    ? (data.cache?.positionVaultIds ?? [])
    : [...new Set(data.positions.map((p) => p.vault.id))];

  const walletAddress = user?.smartWallet?.address ?? user?.wallet?.address;
  const narrationCacheKey = walletAddress ? `bluvfi:narration-cache:${walletAddress}` : null;

  // Fetch AI narration when activities exist
  const activityCount = activities?.length ?? 0;
  useEffect(() => {
    if (activityCount === 0) return;
    if (!narrationCacheKey) return;

    const cached = localStorage.getItem(narrationCacheKey);
    if (cached) setNarration(cached);

    const controller = new AbortController();
    if (!cached) setNarrationLoading(true);
    fetch("/api/activity/narrate", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.json();
      })
      .then((d) => {
        const text = d.narration ?? null;
        setNarration(text);
        if (text) try { localStorage.setItem(narrationCacheKey, text); } catch {}
      })
      .catch((e) => { if (e.name !== "AbortError") setNarration(null); })
      .finally(() => setNarrationLoading(false));
    return () => controller.abort();
  }, [activityCount, narrationCacheKey]);

  const name =
    user?.google?.name?.split(" ")[0] ||
    (user?.apple as { firstName?: string } | undefined)?.firstName ||
    "there";

  const bestApy = useMemo(
    () => data.baseVaults.length
      ? data.baseVaults.reduce((best, v) => {
          const apy = parseFloat(v.yield?.["7d"] || "0");
          return apy > best ? apy : best;
        }, 0)
      : 0,
    [data.baseVaults],
  );

  const prose = useMemo(
    () => getProse(
      data.hasPositions || (data.cache?.positionVaultIds?.length ?? 0) > 0,
      bestApy,
      data.totalSavingsUsd || data.cache?.totalSavingsUsd || 0,
      data.walletBalanceUsd || 0,
    ),
    [data.hasPositions, data.cache, bestApy, data.totalSavingsUsd, data.walletBalanceUsd],
  );

  const greeting = useMemo(() => getGreeting(), []);

  const availableVaultIds = useMemo(
    () => [...new Set(data.baseVaults.map((v) => v.id))],
    [data.baseVaults],
  );

  // Cache-aware flags — show content if real data OR cache is available
  const hasData = !data.userLoading || data.cache !== null;
  const hasGoals = goals ? Object.keys(goals).length > 0 : false;
  const showPositions = data.hasPositions || hasGoals || (data.userLoading && (data.cache?.positionVaultIds?.length ?? 0) > 0);

  // Goals without a matching position — render as motivation cards
  const orphanGoals = useMemo(() => {
    if (!goals) return [];
    const posVaultIds = new Set(data.positions.map((p) => p.vault.id));
    return Object.entries(goals)
      .filter(([vid]) => !posVaultIds.has(vid))
      .map(([vid, goal]) => ({
        vaultId: vid,
        goal,
        vault: data.baseVaults.find((v) => v.id === vid),
      }))
      .filter((e): e is typeof e & { vault: VaultStatsItem } => !!e.vault);
  }, [goals, data.positions, data.baseVaults]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !el.children[0]) return;
    const cardWidth = (el.children[0] as HTMLElement).offsetWidth;
    const gap = 16;
    const idx = Math.round(el.scrollLeft / (cardWidth + gap));
    setActiveCard(Math.min(1, Math.max(0, idx)));
  }, []);

  const cardBase =
    "relative overflow-hidden rounded-[2rem] bg-cream shadow-[0_4px_32px_rgba(0,0,0,0.08),0_1px_4px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.03)]";

  // Liquid metal — emerald (balance card) + gold (savings card)
  const emeraldMetal = {
    background: [
      "radial-gradient(ellipse at 20% 10%, rgba(180,220,190,0.35) 0%, transparent 40%)",
      "radial-gradient(ellipse at 80% 90%, rgba(30,70,40,0.4) 0%, transparent 45%)",
      "radial-gradient(ellipse at 5% 75%, rgba(100,160,110,0.3) 0%, transparent 35%)",
      "radial-gradient(ellipse at 95% 20%, rgba(140,190,150,0.2) 0%, transparent 30%)",
      "conic-gradient(from 150deg at 110% 110%, rgba(60,120,70,0.35), rgba(90,155,100,0.25) 20%, rgba(160,210,165,0.4) 45%, rgba(40,95,50,0.35) 65%, rgba(110,170,120,0.3) 85%, rgba(60,120,70,0.35))",
    ].join(", "),
    borderColor: "rgba(80,140,90,0.3)",
  };

  const goldMetal = {
    background: [
      "radial-gradient(ellipse at 80% 10%, rgba(255,240,200,0.4) 0%, transparent 40%)",
      "radial-gradient(ellipse at 20% 90%, rgba(120,90,30,0.35) 0%, transparent 45%)",
      "radial-gradient(ellipse at 95% 70%, rgba(230,200,130,0.3) 0%, transparent 35%)",
      "radial-gradient(ellipse at 5% 25%, rgba(200,175,100,0.2) 0%, transparent 30%)",
      "conic-gradient(from 200deg at -10% -10%, rgba(180,150,60,0.35), rgba(210,180,90,0.25) 20%, rgba(250,235,170,0.4) 45%, rgba(150,120,40,0.35) 65%, rgba(200,170,80,0.3) 85%, rgba(180,150,60,0.35))",
    ].join(", "),
    borderColor: "rgba(180,150,70,0.3)",
  };

  return (
    <>
    <div
      className="relative min-h-dvh"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* ── Organic mesh gradient ──────────────────────── */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse at 25% 0%, rgba(143,174,130,0.07) 0%, transparent 50%)",
            "radial-gradient(ellipse at 75% 60%, rgba(107,137,168,0.04) 0%, transparent 50%)",
          ].join(", "),
        }}
      />
      {/* ── Enhanced grain overlay ─────────────────────── */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: "url(/noise.svg)",
          backgroundSize: "200px 200px",
          opacity: 0.05,
          mixBlendMode: "multiply",
        }}
      />

      {/* ── Content ────────────────────────────────────── */}
      <div className="relative pt-20 pb-36">
        <div className="px-6 sm:px-10">
          <div className="mx-auto w-full max-w-lg">
            {/* ── Pull-to-refresh indicator ────────────────── */}
            {(pullDistance > 0 || refreshing) && (
              <div
                className="flex items-center justify-center overflow-hidden transition-[height] duration-200"
                style={{ height: refreshing ? 40 : pullDistance * 0.5 }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  className={`text-ink-light/40 ${refreshing ? "animate-spin" : ""}`}
                  style={!refreshing ? { transform: `rotate(${pullDistance * 3}deg)` } : undefined}
                >
                  <path
                    d="M21 12a9 9 0 1 1-6.2-8.6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            )}

            {/* ── Greeting ───────────────────────────────── */}
            <motion.h1
              {...greetReveal}
              className="font-display text-[2rem] leading-snug text-ink sm:text-[2.5rem]"
            >
              {greeting.text}, {name}{" "}
              <span className={`inline-block ${greeting.anim}`}>
                {greeting.emoji}
              </span>
            </motion.h1>
          </div>
        </div>

        {/* ── Card carousel ──────────────────────────────── */}
        <motion.div {...deckReveal} className="mt-8">
          <AnimatePresence mode="wait">
          {displaySavings === null ? (
            <motion.div key="card-skeleton" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <div className="px-6 sm:px-10">
              <div className="mx-auto max-w-lg">
                <div className={cardBase}>
                  <div className="pointer-events-none absolute inset-0 rounded-[inherit] border" style={{ background: emeraldMetal.background, borderColor: emeraldMetal.borderColor }} />
                  <div className="relative aspect-[1.6/1] p-7">
                    <div className="h-4 w-20 animate-pulse rounded bg-ink/[0.06]" />
                    <div className="mt-6 h-10 w-32 animate-pulse rounded bg-ink/[0.08]" />
                  </div>
                </div>
              </div>
            </div>
            </motion.div>
          ) : (
            <motion.div key="card-real" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 sm:px-10"
              >
                {/* ── Balance card (emerald, first) ──────── */}
                <motion.div
                  className="w-full flex-none snap-center"
                  animate={{ opacity: activeCard === 0 ? 1 : 0.6 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="cursor-pointer" onClick={() => setFlippedCard(flippedCard === 0 ? null : 0)}>
                    <div className={cardBase}>
                      <div className="pointer-events-none absolute inset-0 rounded-[inherit] border" style={{ background: emeraldMetal.background, borderColor: emeraldMetal.borderColor }} />
                      <CardGrain />
                      <span className="pointer-events-none absolute right-5 bottom-5 font-display text-[3rem] leading-none text-ink/[0.04] select-none" style={{ transform: "rotate(-8deg)" }}>Bluvfi</span>
                      <div className="relative flex aspect-[1.6/1] flex-col p-6">
                        <AnimatePresence mode="wait" initial={false}>
                          {flippedCard !== 0 ? (
                            <motion.div key="balance-front" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="flex flex-1 flex-row">
                              {/* Left — balance info */}
                              <div className="flex flex-1 flex-col">
                                <p className="font-display italic text-[13px] text-ink/60">Wallet balance</p>
                                <div className="mt-auto">
                                  <OdometerNumber value={displayBalance ?? 0} format={formatUsd} className="font-display text-[2.8rem] leading-none tracking-tight text-ink sm:text-[3.2rem]" />
                                  <p className="mt-1.5 font-body text-[10px] text-ink/60 transition-[opacity] duration-300" style={{ opacity: data.walletAssets.length > 0 ? 1 : 0 }}>
                                    {data.walletAssets.length > 0 ? `${data.walletAssets.length} ${data.walletAssets.length === 1 ? "asset" : "assets"} · tap to see breakdown` : "\u00a0"}
                                  </p>
                                </div>
                              </div>
                              {/* Right — action pills */}
                              <div className="flex flex-col items-center justify-center gap-3">
                                {[
                                  { label: "Add", icon: "M8 3v10M3 8h10", onClick: onAddFunds },
                                  { label: "Send", icon: "M8 12V4M5 7l3-3 3 3", onClick: onSend },
                                  { label: "Receive", icon: "M8 4v8M5 9l3 3 3-3", onClick: onReceive },
                                ].map((action) => (
                                  <button
                                    key={action.label}
                                    onClick={(e) => { e.stopPropagation(); action.onClick?.(); }}
                                    className="group flex flex-col items-center gap-0.5 transition-transform duration-200 active:scale-[0.88]"
                                  >
                                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink/[0.06] transition-[background-color,transform] duration-200 group-hover:bg-ink/[0.12] group-hover:scale-110">
                                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="transition-transform duration-200 group-hover:scale-110">
                                        <path d={action.icon} stroke="var(--color-ink)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                      </svg>
                                    </span>
                                    <span className="font-body text-[9px] text-ink/40 transition-colors duration-200 group-hover:text-ink/70">{action.label}</span>
                                  </button>
                                ))}
                              </div>
                            </motion.div>
                          ) : (
                            <motion.div key="balance-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="flex flex-1 flex-col">
                              <p className="font-display italic text-[13px] text-ink/60">Breakdown</p>
                              <div className="mt-auto divide-y divide-ink/[0.07]">
                                {data.walletAssets.slice(0, 4).map((a) => (
                                  <div key={a.symbol} className="flex items-baseline justify-between py-1.5">
                                    <span className="font-body text-[13px] text-ink">{a.symbol}</span>
                                    <span className="font-mono text-[12px] tabular-nums text-ink/70">{parseFloat(a.balance).toLocaleString("en-US", { maximumFractionDigits: 4 })}</span>
                                  </div>
                                ))}
                                {data.walletAssets.length === 0 && <p className="font-body text-sm text-ink-light/40 py-1.5">No assets yet</p>}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                </motion.div>

                {/* ── Savings card (gold, second) ──────── */}
                <motion.div
                  className="w-full flex-none snap-center"
                  animate={{ opacity: activeCard === 1 ? 1 : 0.6 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="cursor-pointer" onClick={() => setFlippedCard(flippedCard === 1 ? null : 1)}>
                    <div className={cardBase}>
                      <div className="pointer-events-none absolute inset-0 rounded-[inherit] border" style={{ background: goldMetal.background, borderColor: goldMetal.borderColor }} />
                      <CardGrain />
                      <span className="pointer-events-none absolute right-5 bottom-5 font-display text-[3rem] leading-none text-ink/[0.04] select-none" style={{ transform: "rotate(-8deg)" }}>Bluvfi</span>
                      <div className="relative flex aspect-[1.6/1] flex-col p-6">
                        <AnimatePresence mode="wait" initial={false}>
                          {flippedCard !== 1 ? (
                            <motion.div key="savings-front" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="flex flex-1 flex-col">
                              <p className="font-display italic text-[13px] text-ink/60">
                                {data.hasPositions || displayVaultIds.length > 0 ? "Total savings" : "Earn up to"}
                              </p>
                              <div className="mt-auto">
                                {data.hasPositions || displayVaultIds.length > 0 ? (
                                  <>
                                    <OdometerNumber value={displaySavings} format={formatUsd} className="font-display text-[2.8rem] leading-none tracking-tight text-ink sm:text-[3.2rem]" />
                                    <p className="mt-1.5 font-body text-[10px] text-ink/60 transition-[opacity] duration-300" style={{ opacity: displayVaultIds.length > 0 ? 1 : 0 }}>
                                      {displayVaultIds.length > 0 ? `across ${displayVaultIds.length} ${displayVaultIds.length === 1 ? "vault" : "vaults"} · tap to see breakdown` : "\u00a0"}
                                    </p>
                                  </>
                                ) : (
                                  <p className="font-display text-[2.8rem] leading-none tracking-tight text-ink/60 sm:text-[3.2rem]">{bestApy > 0 ? formatApy(String(bestApy)) : "5.0%"}</p>
                                )}
                              </div>
                            </motion.div>
                          ) : (
                            <motion.div key="savings-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="flex flex-1 flex-col">
                              <p className="font-display italic text-[13px] text-ink/60">Breakdown</p>
                              <div className="mt-auto divide-y divide-ink/[0.07]">
                                {data.positions.map((p) => {
                                  const vName = VAULT_FRIENDLY_NAMES[p.vault.id] || p.vault.name;
                                  const vApy = formatApy(p.vault.yield?.["7d"]);
                                  const usd = Number(p.position.assets) / 10 ** p.vault.asset.decimals * (data.prices?.[p.vault.asset.symbol.toLowerCase()] || 1);
                                  return (
                                    <div key={p.vault.id} className="flex items-baseline justify-between py-1.5">
                                      <span className="font-body text-[13px] text-ink">{vName}</span>
                                      <span className="font-mono text-[11px] tabular-nums text-ink/70">{formatUsd(usd)} <span className="text-ink-light/50">{vApy}</span></span>
                                    </div>
                                  );
                                })}
                                {data.positions.length === 0 && <p className="font-body text-sm text-ink-light/40 py-1.5">No savings yet</p>}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </div>

              {/* ── Pill indicators ──────────────────────── */}
              <div className="mt-3 flex justify-center gap-1.5">
                {[0, 1].map((i) => (
                  <span
                    key={i}
                    className={`h-1 rounded-full transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                      activeCard === i ? "w-5 bg-ink" : "w-1.5 bg-ink/20"
                    }`}
                  />
                ))}
              </div>
            </motion.div>
          )}
          </AnimatePresence>

        </motion.div>

        {/* ── Editorial prose ────────────────────────────── */}
        <div className="px-6 sm:px-10">
          <div className="mx-auto w-full max-w-lg">
            {hasData && (
              <motion.p
                {...proseReveal}
                className="mt-6 font-body text-[1.25rem] leading-relaxed text-ink sm:text-[1.4rem]"
              >
                {prose}
              </motion.p>
            )}

            {/* ── Positions + Goals ──────────────────────── */}
            {hasData && showPositions && (
              <motion.section {...sectionReveal(0)} className="mt-10">
                <p className="font-body text-[1.25rem] leading-relaxed text-ink sm:text-[1.4rem]">
                  {data.hasPositions
                    ? "Here\u2019s where your money is working."
                    : "Here\u2019s what you\u2019re saving for."}
                </p>
                <div className="mt-4 space-y-3">
                  {data.positions.length > 0 || orphanGoals.length > 0 ? (
                    <>
                      {data.positions.map((p, i) => (
                        <motion.div
                          key={`${p.vault.id}-${p.vault.chain.id}`}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.07, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <PositionCard
                            vault={p.vault}
                            position={p.position}
                            prices={data.prices}
                            goal={goals?.[p.vault.id]}
                            onTap={onPositionTap}
                            onRemoveGoal={goals?.[p.vault.id] ? () => handleRemoveGoal(p.vault.id) : undefined}
                            onAddGoal={!goals?.[p.vault.id] ? () => setAddGoalVault(p.vault) : undefined}
                          />
                        </motion.div>
                      ))}
                      {orphanGoals.map((entry, i) => (
                        <motion.div
                          key={`goal-${entry.vaultId}`}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: (data.positions.length + i) * 0.07, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <GoalCard
                            goal={entry.goal}
                            vault={entry.vault}
                            onTap={onVaultTap}
                            onRemoveGoal={() => handleRemoveGoal(entry.vaultId)}
                          />
                        </motion.div>
                      ))}
                    </>
                  ) : (
                    <div className="h-16 animate-pulse rounded-xl bg-ink/[0.04]" />
                  )}
                </div>
              </motion.section>
            )}
          </div>
        </div>

        {/* ── Vaults (horizontal scroll, full-bleed) ──── */}
        {!data.vaultsLoading && data.baseVaults.length > 0 && (
          <motion.section {...sectionReveal(1)} className="mt-10">
            <div className="px-6 sm:px-10">
              <div className="mx-auto w-full max-w-lg">
                <p className="font-body text-[1.25rem] leading-relaxed text-ink sm:text-[1.4rem]">
                  {showPositions
                    ? "You could also earn across these."
                    : "Here\u2019s what you could be earning."}
                </p>
              </div>
            </div>
            <div className="relative mt-4">
              <div className="flex gap-3 overflow-x-auto px-6 pb-2 sm:px-10">
                {data.baseVaults.map((vault) => (
                  <VaultCard
                    key={`${vault.id}-${vault.chain.id}`}
                    vault={vault}
                    onTap={onVaultTap}
                  />
                ))}
                <div className="w-3 flex-none" />
              </div>
              <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-10 bg-gradient-to-l from-cream to-transparent" />
            </div>
          </motion.section>
        )}

        {/* ── Activity ───────────────────────────────────── */}
        {(activityCount > 0 || narration) && (
          <div className="px-6 sm:px-10">
            <div className="mx-auto w-full max-w-lg">
              <motion.section {...sectionReveal(2)} className="mt-10">
                <div className="flex items-center gap-3">
                  <p className="font-body text-[1.25rem] leading-relaxed text-ink sm:text-[1.4rem]">
                    And here&rsquo;s what happened recently.
                  </p>
                  <button
                    onClick={() => setActivityMode((m) => (m === "prose" ? "list" : "prose"))}
                    className="flex-none text-ink/60 transition-colors duration-200 hover:text-ink-light"
                    aria-label={activityMode === "prose" ? "Switch to list view" : "Switch to prose view"}
                  >
                    {activityMode === "prose" ? (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M2 4h12M2 8h12M2 12h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    )}
                  </button>
                </div>
                <div className="mt-4">
                  <AnimatePresence mode="wait">
                    {activityMode === "prose" ? (
                      <motion.div
                        key="prose"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                      >
                        {narrationLoading ? (
                          <>
                            <div className="h-5 w-3/4 animate-pulse rounded bg-ink/[0.06]" />
                            <div className="mt-2 h-5 w-1/2 animate-pulse rounded bg-ink/[0.06]" />
                          </>
                        ) : narration ? (
                          <p className="font-body text-[1.25rem] leading-relaxed text-ink sm:text-[1.4rem]">
                            {highlightNarration(narration)}
                          </p>
                        ) : (
                          <ActivityList activities={(activities ?? []).slice(0, 5)} />
                        )}
                      </motion.div>
                    ) : (
                      <motion.div
                        key="list"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                      >
                        <ActivityList activities={(activities ?? []).slice(0, 5)} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.section>
            </div>
          </div>
        )}

        {/* ── Quick-start chips (empty state) ────────────── */}
        {hasData && !showPositions && (
          <div className="px-6 sm:px-10">
            <div className="mx-auto w-full max-w-lg">
              <motion.div
                {...chipsReveal}
                className="mt-6 flex flex-wrap gap-2"
              >
                {["Emergency fund", "Vacation", "Just earning"].map((goal) => (
                  <button
                    key={goal}
                    onClick={() =>
                      open(
                        goal === "Just earning"
                          ? "I just want to earn the best interest on my money"
                          : `I want to start saving for ${goal.toLowerCase()}`
                      )
                    }
                    className="rounded-full border border-border/60 bg-cream-dark/30 px-4 py-2.5 font-mono text-xs tracking-wide text-ink-light backdrop-blur-sm transition-all duration-300 hover:border-sage/40 hover:text-ink"
                  >
                    {goal}
                  </button>
                ))}
              </motion.div>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* AddGoalSheet portal */}
    {addGoalVault && (
      <AddGoalSheet
        vault={addGoalVault}
        onClose={() => setAddGoalVault(null)}
        onSuccess={async () => { await refetchGoals(); setAddGoalVault(null); }}
      />
    )}
    </>
  );
}
