"use client";

import { useState, useRef, useEffect } from "react";
import { usePrivy, useLogout, useWallets } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import type { ReactNode } from "react";
import { formatUsd } from "@/lib/format";
import { getUserFirstName } from "@/lib/user-display-name";
import { useStablecoinBalances } from "@/hooks/use-stablecoin-balances";
import { getPrivyEmbeddedWallets } from "@/lib/privy-wallets";

interface SettingsSidebarProps {
  open: boolean;
  onClose: () => void;
}

function CopyableWallet({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const truncated = `${address.slice(0, 6)}...${address.slice(-4)}`;

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 font-mono text-sm text-ink transition-colors duration-200 hover:text-ink/60"
    >
      <span>{truncated}</span>
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-sage">
          <path d="M3 7.5l2.5 2.5L11 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-ink/40">
          <rect x="5" y="5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M9 5V3.5A1.5 1.5 0 007.5 2h-4A1.5 1.5 0 002 3.5v4A1.5 1.5 0 003.5 9H5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </button>
  );
}

export function SettingsSidebar({
  open,
  onClose,
}: SettingsSidebarProps) {
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { logout } = useLogout({
    onSuccess: () => {
      queryClient.clear();
      // Use replace + window.location to fully clear any OAuth params
      // (privy_oauth_code, privy_oauth_state) that may be in the URL,
      // so the next login attempt doesn't hit a stale redirect URL.
      window.location.replace("/");
    },
  });

  const { evmAddress, solanaAddress, smartWalletAddress } = getPrivyEmbeddedWallets(user as any, wallets);
  const displayEvmAddress = smartWalletAddress ?? evmAddress;
  const { evmUsdc, evmUsdt, solUsdc, solUsdt, isLoading: sbLoading } = useStablecoinBalances();

  // Persistent XRPL wallet — created lazily (idempotent) on first load, then cached.
  const [xrplAddress, setXrplAddress] = useState<string | null>(null);
  const [xrplWalletRequestId, setXrplWalletRequestId] = useState<string | null>(null);
  const [xrplLoading, setXrplLoading] = useState(false);
  const [xrplError, setXrplError] = useState<string | null>(null);
  const [xrplRetryTick, setXrplRetryTick] = useState(0);
  useEffect(() => {
    if (!open || xrplAddress) return;
    setXrplLoading(true);
    setXrplError(null);
    fetch("/api/xrpl/sidebar-wallet")
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.error ?? `Request failed (${r.status})`);
        return data;
      })
      .then((data) => {
        if (data?.address) {
          setXrplAddress(data.address);
          setXrplWalletRequestId(data.id ?? null);
        } else throw new Error("No address returned");
      })
      .catch((err: unknown) => {
        // 501 means the XRPL service simply isn't configured in this
        // environment — that's expected/silent, not a real error to surface.
        const msg = (err as Error)?.message ?? "";
        if (!msg.includes("not configured")) setXrplError(msg || "Failed to load XRPL wallet");
      })
      .finally(() => setXrplLoading(false));
  }, [open, xrplAddress, xrplRetryTick]);

  // Live XRP balance — derived strictly through bluvfi-xrpl (its own
  // GET /wallet-requests/:id activity history), never a direct call to the
  // XRP Ledger or any other external service. Refetched whenever the
  // sidebar (re)opens with a known wallet, not on a timer.
  const [xrplBalance, setXrplBalance] = useState<number | null>(null);
  const [xrplBalanceLoading, setXrplBalanceLoading] = useState(false);
  useEffect(() => {
    if (!open || !xrplWalletRequestId) return;
    setXrplBalanceLoading(true);
    fetch(`/api/xrpl/balance?walletRequestId=${encodeURIComponent(xrplWalletRequestId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (typeof data?.balanceXrp === "number") setXrplBalance(data.balanceXrp); })
      .catch(() => {})
      .finally(() => setXrplBalanceLoading(false));
  }, [open, xrplWalletRequestId]);

  const email = user?.email?.address || user?.google?.email;
  const firstName = getUserFirstName(user) ?? "User";
  const initial = firstName.charAt(0).toUpperCase();

  return (
    <motion.div
      animate={{ opacity: open ? 1 : 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-10 flex flex-col bg-cream-dark pl-6 pr-[22%] pt-[max(env(safe-area-inset-top),48px)] pb-[max(env(safe-area-inset-bottom),24px)]"
      style={{ pointerEvents: open ? "auto" : "none" }}
    >
      {/* Profile header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sage/20">
          <span className="font-display text-base text-sage">
            {initial}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-lg text-ink">
            {firstName}
          </p>
          {email && (
            <p className="truncate font-mono text-[10px] text-ink-light">
              {email}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 h-px bg-ink/20" />

      {/* Wallet section */}
      <div className="mt-5 space-y-5">
        {(displayEvmAddress || solanaAddress) && (
          <div className="space-y-3">
            {displayEvmAddress && (
              <div>
                <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">EVM Wallet</span>
                <div className="mt-1.5">
                  <CopyableWallet address={displayEvmAddress} />
                </div>
              </div>
            )}
            {solanaAddress && (
              <div>
                <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Solana Wallet</span>
                <div className="mt-1.5">
                  <CopyableWallet address={solanaAddress} />
                </div>
              </div>
            )}
            {xrplAddress ? (
              <div>
                <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">XRPL Wallet</span>
                <div className="mt-1.5">
                  <CopyableWallet address={xrplAddress} />
                </div>
              </div>
            ) : xrplLoading ? (
              <div>
                <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">XRPL Wallet</span>
                <div className="mt-1.5 h-5 w-40 animate-pulse rounded bg-ink/10" />
              </div>
            ) : xrplError ? (
              <div>
                <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">XRPL Wallet</span>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="font-mono text-xs text-red-500/80">Couldn&apos;t load</span>
                  <button
                    onClick={() => setXrplRetryTick((n) => n + 1)}
                    className="font-mono text-xs text-ink underline underline-offset-2 hover:text-ink/60"
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* 4 balance rows — one per token per network */}
        {(displayEvmAddress || solanaAddress) && (
          <div className="space-y-3">
            <span className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Balances</span>

            {displayEvmAddress && (
              <>
                {/* EVM USDC */}
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-ink-light">EVM USDC</span>
                  <span className="font-display text-sm font-semibold text-ink">
                    {sbLoading ? "…" : formatUsd(evmUsdc)}
                  </span>
                </div>
                {/* EVM USDT */}
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-ink-light">EVM USDT</span>
                  <span className="font-display text-sm font-semibold text-ink">
                    {sbLoading ? "…" : formatUsd(evmUsdt)}
                  </span>
                </div>
              </>
            )}

            {solanaAddress && (
              <>
                {/* Solana USDC */}
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-ink-light">SOL USDC</span>
                  <span className="font-display text-sm font-semibold text-ink">
                    {sbLoading ? "…" : formatUsd(solUsdc)}
                  </span>
                </div>
                {/* Solana USDT */}
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-ink-light">SOL USDT</span>
                  <span className="font-display text-sm font-semibold text-ink">
                    {sbLoading ? "…" : formatUsd(solUsdt)}
                  </span>
                </div>
              </>
            )}

            {xrplAddress && (
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-ink-light">XRP</span>
                <span className="font-display text-sm font-semibold text-ink">
                  {xrplBalanceLoading || xrplBalance === null
                    ? "…"
                    : `${xrplBalance.toFixed(4)} XRP`}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* Social links */}
      <div className="mb-4 flex items-center gap-3">
        <a
          href="https://x.com/bluvfi"
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-ink/10 bg-ink/[0.04] px-3 py-2.5 font-mono text-xs text-ink/60 transition-colors hover:bg-ink/[0.08] hover:text-ink/90"
        >
          {/* X (Twitter) icon */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.402 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.261 5.634 5.903-5.634Zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          <span>@bluvfi</span>
        </a>
        <a
          href="https://t.me/+KXpDSUAnfg44MTg0"
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-ink/10 bg-ink/[0.04] px-3 py-2.5 font-mono text-xs text-ink/60 transition-colors hover:bg-ink/[0.08] hover:text-ink/90"
        >
          {/* Telegram icon */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 14.426l-2.965-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.893.133z" />
          </svg>
          <span>Telegram</span>
        </a>
      </div>

      {/* Logout */}
      <button
        onClick={() => logout()}
        className="w-full rounded-xl border border-fail/30 bg-fail/[0.08] px-4 py-3 font-mono text-xs tracking-wide text-fail transition-colors duration-200 hover:bg-fail/15"
      >
        Log out
      </button>
    </motion.div>
  );
}

export function ScreenStackWrapper({
  open,
  onOpen,
  onClose,
  children,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const touch = useRef({ x: 0, y: 0 });

  const onTouchStart = (e: React.TouchEvent) => {
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const onSwipeEnd = (e: React.TouchEvent, action: "open" | "close") => {
    const dx = e.changedTouches[0].clientX - touch.current.x;
    const dy = e.changedTouches[0].clientY - touch.current.y;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (action === "open" && dx > 0) onOpen();
      if (action === "close" && dx < 0) onClose();
    }
  };

  return (
    <>
      {/* Left-edge swipe zone — invisible strip to detect swipe-to-open */}
      {!open && (
        <div
          className="fixed top-0 left-0 bottom-0 w-5"
          style={{ zIndex: 25 }}
          onTouchStart={onTouchStart}
          onTouchEnd={(e) => onSwipeEnd(e, "open")}
        />
      )}

      <motion.div
        animate={
          open
            ? { x: "82%", borderRadius: 40 }
            : { x: "0%", borderRadius: 0 }
        }
        transition={{
          x: { type: "spring", damping: 26, stiffness: 260 },
          borderRadius: open
            ? { type: "spring", damping: 26, stiffness: 260 }
            : { duration: 0.1 },
        }}
        className="relative z-20 min-h-dvh bg-cream"
        style={{
          overflow: open ? "hidden" : undefined,
          height: open ? "100dvh" : undefined,
          willChange: "transform",
          boxShadow: open
            ? "-6px 0 48px rgba(0,0,0,0.25), -2px 0 8px rgba(0,0,0,0.10)"
            : "none",
        }}
      >
        {/* Dark dim overlay — tap or swipe left to close */}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 z-50 cursor-pointer bg-black/[0.20]"
              onTouchStart={onTouchStart}
              onTouchEnd={(e) => onSwipeEnd(e, "close")}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            />
          )}
        </AnimatePresence>
        {children}
      </motion.div>
    </>
  );
}
