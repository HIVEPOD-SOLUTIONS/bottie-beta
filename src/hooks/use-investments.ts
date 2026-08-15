"use client";

import { useState, useEffect, useCallback } from "react";

export interface InvestmentPosition {
  id: string;
  symbol: string;
  name: string;
  type: string;
  shares: number;
  avgPriceUsd: number;
  currentPriceUsd: number;
  currentValueUsd: number;
  gainLossUsd: number;
  gainLossPct: number;
  icon: string;
  description: string;
  change24h: number;
}

export function useInvestments() {
  const [portfolio, setPortfolio] = useState<InvestmentPosition[]>([]);
  const [totalValueUsd, setTotalValueUsd] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/investments");
      if (!res.ok) throw new Error("Failed to load portfolio");
      const data = await res.json();
      setPortfolio(data.portfolio ?? []);
      setTotalValueUsd(data.totalValueUsd ?? 0);
    } catch (err: any) {
      setError(err?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  return { portfolio, totalValueUsd, loading, error, refetch };
}
