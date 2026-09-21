"use client";

import { useQuery } from "@tanstack/react-query";
import { usePrivy } from "@privy-io/react-auth";
import { authFetch } from "@/lib/api-auth-fetch";
import type { PriceSnapshot } from "@/lib/coinmarketcap-parse";

/**
 * Live crypto prices for the dashboard ticker, from /api/prices.
 *
 * Polls every 30s. CoinMarketCap itself only refreshes about every 60s, so
 * some polls return unchanged numbers — that's expected; the server caches so
 * they cost nothing upstream. React Query pauses the interval while the tab
 * is hidden and refetches on refocus, so a returning user sees fresh prices
 * immediately rather than waiting out a tick.
 */

const POLL_MS = 30_000;

/** 501 from the API: no CoinMarketCap key in this environment. Not a failure — stop polling and hide the ticker. */
class PriceFeedNotConfigured extends Error {}

export function useCryptoPrices() {
  const { ready, authenticated, getAccessToken } = usePrivy();

  return useQuery<PriceSnapshot>({
    queryKey: ["crypto-prices"],
    enabled: ready && authenticated,
    queryFn: async () => {
      const res = await authFetch("/api/prices", undefined, getAccessToken);
      if (res.status === 501) throw new PriceFeedNotConfigured();
      if (!res.ok) throw new Error(`Prices unavailable (${res.status})`);
      return res.json();
    },
    refetchInterval: (query) => (query.state.error instanceof PriceFeedNotConfigured ? false : POLL_MS),
    staleTime: POLL_MS - 5_000,
    // Retry transient failures a couple of times, but never a "not configured".
    retry: (count, error) => !(error instanceof PriceFeedNotConfigured) && count < 2,
  });
}
