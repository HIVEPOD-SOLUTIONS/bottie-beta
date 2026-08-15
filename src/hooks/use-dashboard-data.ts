"use client";

import { useMemo, useEffect, useState, useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import {
  useVaults,
  useUserPositions,
  usePrices,
} from "@yo-protocol/react";
import type { VaultStatsItem, UserVaultPosition } from "@yo-protocol/core";
import type { Address } from "viem";
import { DEFAULT_CHAIN_ID, VAULT_DISPLAY_ORDER } from "@/lib/constants";
import { assetsToUsd, getPrice } from "@/lib/format";
import { useStablecoinBalances } from "@/hooks/use-stablecoin-balances";

export interface TypedPosition {
  vault: VaultStatsItem;
  position: UserVaultPosition;
}

export interface DashboardCache {
  totalSavingsUsd: number;
  walletBalanceUsd: number;
  positionVaultIds: string[];
  timestamp: number;
}

export interface WalletAsset {
  symbol: string;
  balance: string;
  balanceUsd: string;
}

export interface DashboardData {
  baseVaults: VaultStatsItem[];
  allVaults: VaultStatsItem[];
  vaultsLoading: boolean;

  walletAddress: Address | undefined;
  walletBalanceUsd: number;
  walletAssets: WalletAsset[];
  totalSavingsUsd: number;
  positions: TypedPosition[];
  hasPositions: boolean;
  userLoading: boolean;

  prices: Record<string, number>;

  cache: DashboardCache | null;

  refetchPositions: () => Promise<unknown>;
  refetchBalances: () => void;
}

const CACHE_KEY = "bluvfi:dashboard-cache";

function readCache(): DashboardCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function useDashboardData(): DashboardData {
  const { user } = usePrivy();
  const walletAddress = (user?.smartWallet?.address ?? user?.wallet?.address) as Address | undefined;

  const { vaults = [], isLoading: vaultsLoading } = useVaults();
  const {
    positions: rawPositions = [],
    isLoading: positionsLoading,
    refetch: refetchPositions,
  } = useUserPositions(walletAddress, { enabled: !!walletAddress });
  const { prices = {} } = usePrices();

  // ── Balance: three-tier fallback (Privy → viem/web3.js → Alchemy RPC) ──────
  // Same hook used by the sidebar — single source of truth for wallet balances.
  const {
    evmUsdc,
    evmUsdt,
    solUsdc,
    solUsdt,
    isLoading: balancesLoading,
  } = useStablecoinBalances();

  const walletBalanceUsd = evmUsdc + evmUsdt + solUsdc + solUsdt;

  // No-op refetch — useStablecoinBalances refreshes on its own 30s interval.
  // Kept in the return shape so callers that call refetchBalances() don't break.
  const refetchBalances = useCallback(() => {}, []);

  // Build walletAssets from the four stablecoin buckets (filter dust < $0.01)
  const walletAssets = useMemo<WalletAsset[]>(() => {
    const buckets = [
      { symbol: "USDC", amount: evmUsdc,  label: "EVM"    },
      { symbol: "USDT", amount: evmUsdt,  label: "EVM"    },
      { symbol: "USDC", amount: solUsdc,  label: "Solana" },
      { symbol: "USDT", amount: solUsdt,  label: "Solana" },
    ];
    return buckets
      .filter((b) => b.amount > 0.01)
      .map((b) => ({
        symbol:     `${b.symbol} (${b.label})`,
        balance:    b.amount.toFixed(6),
        balanceUsd: b.amount.toFixed(2),
      }));
  }, [evmUsdc, evmUsdt, solUsdc, solUsdt]);

  const [cache] = useState<DashboardCache | null>(readCache);

  const baseVaults = useMemo(() => {
    const filtered = vaults.filter(
      (v: VaultStatsItem) => v.chain.id === DEFAULT_CHAIN_ID,
    );
    return filtered.sort((a: VaultStatsItem, b: VaultStatsItem) => {
      const aIdx = VAULT_DISPLAY_ORDER.indexOf(a.id as (typeof VAULT_DISPLAY_ORDER)[number]);
      const bIdx = VAULT_DISPLAY_ORDER.indexOf(b.id as (typeof VAULT_DISPLAY_ORDER)[number]);
      return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    });
  }, [vaults]);

  const positions = useMemo(() => {
    return rawPositions
      .map((p: { vault: unknown; position: UserVaultPosition }) => ({
        vault: p.vault as VaultStatsItem,
        position: p.position,
      }))
      .filter((p) => p.position.assets > 0n);
  }, [rawPositions]);

  const totalSavingsUsd = useMemo(() => {
    return positions.reduce((sum, p) => {
      const price = getPrice(prices, p.vault.asset.symbol);
      return sum + assetsToUsd(p.position.assets, p.vault.asset.decimals, price);
    }, 0);
  }, [positions, prices]);

  const userLoading = positionsLoading || balancesLoading;

  // Write to cache when fresh data arrives
  useEffect(() => {
    if (!userLoading && walletAddress) {
      try {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({
            totalSavingsUsd,
            walletBalanceUsd,
            positionVaultIds: positions.map((p) => p.vault.id),
            timestamp: Date.now(),
          }),
        );
      } catch {
        // silent fail
      }
    }
  }, [userLoading, walletAddress, totalSavingsUsd, walletBalanceUsd, positions]);

  return useMemo(
    () => ({
      baseVaults,
      allVaults: vaults,
      vaultsLoading,

      walletAddress,
      walletBalanceUsd,
      walletAssets,
      totalSavingsUsd,
      positions,
      hasPositions: positions.length > 0,
      userLoading,

      prices,

      cache,

      refetchPositions,
      refetchBalances,
    }),
    [
      baseVaults,
      vaults,
      vaultsLoading,
      walletAddress,
      walletBalanceUsd,
      walletAssets,
      totalSavingsUsd,
      positions,
      userLoading,
      prices,
      cache,
      refetchPositions,
      refetchBalances,
    ],
  );
}

