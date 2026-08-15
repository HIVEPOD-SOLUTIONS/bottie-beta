"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallets } from "@privy-io/react-auth";
import { arcKit, SOLANA_ARC_BALANCE_CHAIN, SOLANA_ARC_MAINNET_ENABLED } from "@/lib/arc-kit";

// ── Chains to query ────────────────────────────────────────────────────────────
// Mainnet chains — matches AGENT_CHAIN = Base mainnet.
export const EVM_BALANCE_CHAINS = [
  "Base",
  "Ethereum",
  "Arbitrum",
  "Optimism",
  "Polygon",
  "Avalanche",
] as const;

// Always "Solana" (mainnet) — SOLANA_ARC_MAINNET_ENABLED = true.
export const SOLANA_BALANCE_CHAIN = SOLANA_ARC_BALANCE_CHAIN;

// ── Display metadata ───────────────────────────────────────────────────────────
export const CHAIN_META: Record<string, { label: string; icon: string; color: string }> = {
  Base:      { label: "Base",      icon: "🔷", color: "#0052FF" },
  Ethereum:  { label: "Ethereum",  icon: "⟠",  color: "#627EEA" },
  Arbitrum:  { label: "Arbitrum",  icon: "🔵", color: "#28A0F0" },
  Optimism:  { label: "Optimism",  icon: "🔴", color: "#FF0420" },
  Polygon:   { label: "Polygon",   icon: "🟣", color: "#8247E5" },
  Avalanche: { label: "Avalanche", icon: "🔺", color: "#E84142" },
  Solana:    { label: "Solana",    icon: "◎",  color: "#9945FF" },
};

// ── Types ─────────────────────────────────────────────────────────────────────
export type ChainBalance = {
  chain: string;
  label: string;
  icon: string;
  color: string;
  confirmedBalance: string;     // human-readable decimal, e.g. "10.50"
  pendingBalance?: string;
  hasFunds: boolean;            // confirmedBalance > 0
};

export type UnifiedBalanceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; totalUsdc: string; chains: ChainBalance[]; fundedCount: number; emptyCount: number; lastFetched: Date }
  | { status: "error"; message: string };

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useUnifiedBalance(opts?: { includePending?: boolean; autoRefreshMs?: number }) {
  const { wallets } = useWallets();
  const [state, setState] = useState<UnifiedBalanceState>({ status: "idle" });

  const evmWallet = wallets.find((w) => w.walletClientType === "privy" || (w as any).chainType === "ethereum");
  const solWallet = wallets.find((w) => (w as any).chainType === "solana");

  const fetch = useCallback(async () => {
    if (!evmWallet && !solWallet) {
      setState({ status: "idle" });
      return;
    }

    setState({ status: "loading" });

    try {
      // Build sources: EVM address queries EVM chains, Solana address queries Solana chain.
      // Pass both in one call so Arc AppKit returns a unified result.
      const sources: object[] = [];

      if (evmWallet?.address) {
        sources.push({
          address: evmWallet.address,
          chains: [...EVM_BALANCE_CHAINS],
        });
      }

      if (solWallet?.address) {
        sources.push({
          address: solWallet.address,
          chains: [SOLANA_BALANCE_CHAIN],
        });
      }

      const result = await arcKit.unifiedBalance.getBalances({
        token: "USDC",
        sources: sources.length === 1 ? sources[0] : sources,
        includePending: opts?.includePending ?? true,
        networkType: "mainnet",
      } as any);

      // Flatten per-chain breakdowns from all depositor accounts.
      // Multiple depositors may share the same chain — merge them.
      const chainMap = new Map<string, { confirmed: number; pending: number }>();

      for (const depositor of result.breakdown ?? []) {
        for (const entry of depositor.breakdown ?? []) {
          const key = entry.chain as string;
          const prev = chainMap.get(key) ?? { confirmed: 0, pending: 0 };
          chainMap.set(key, {
            confirmed: prev.confirmed + parseFloat(entry.confirmedBalance ?? "0"),
            pending: prev.pending + parseFloat((entry as any).pendingBalance ?? "0"),
          });
        }
      }

      // Build the output list — show ALL queried chains so empty ones are visible.
      const allChains = [
        ...(evmWallet ? EVM_BALANCE_CHAINS : []),
        ...(solWallet ? [SOLANA_BALANCE_CHAIN] : []),
      ];

      const chains: ChainBalance[] = allChains.map((chain) => {
        const bal = chainMap.get(chain) ?? { confirmed: 0, pending: 0 };
        const meta = CHAIN_META[chain] ?? { label: chain, icon: "🔗", color: "#A7A79A" };
        return {
          chain,
          label: meta.label,
          icon: meta.icon,
          color: meta.color,
          confirmedBalance: bal.confirmed.toFixed(2),
          pendingBalance: bal.pending > 0 ? bal.pending.toFixed(2) : undefined,
          hasFunds: bal.confirmed > 0,
        };
      });

      // Sort: funded chains first, then empty.
      chains.sort((a, b) => {
        if (a.hasFunds && !b.hasFunds) return -1;
        if (!a.hasFunds && b.hasFunds) return 1;
        return parseFloat(b.confirmedBalance) - parseFloat(a.confirmedBalance);
      });

      const totalUsdc = chains.reduce((s, c) => s + parseFloat(c.confirmedBalance), 0).toFixed(2);
      const fundedCount = chains.filter((c) => c.hasFunds).length;
      const emptyCount = chains.length - fundedCount;

      setState({
        status: "success",
        totalUsdc,
        chains,
        fundedCount,
        emptyCount,
        lastFetched: new Date(),
      });
    } catch (err: any) {
      setState({ status: "error", message: err?.message ?? "Failed to fetch balances" });
    }
  }, [evmWallet?.address, solWallet?.address, opts?.includePending]);

  // Fetch on mount and when wallets change.
  useEffect(() => { fetch(); }, [fetch]);

  // Optional auto-refresh.
  useEffect(() => {
    if (!opts?.autoRefreshMs) return;
    const id = setInterval(fetch, opts.autoRefreshMs);
    return () => clearInterval(id);
  }, [fetch, opts?.autoRefreshMs]);

  return { state, refresh: fetch };
}
