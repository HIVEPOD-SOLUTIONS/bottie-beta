"use client";

/**
 * Fetches the latest weekly spending insight for the current user.
 *
 * On first mount — if no insight exists for the current week — it automatically
 * triggers generation via POST /api/insights/weekly (fire-and-forget; user
 * sees loading state then the fresh summary).
 */

import { useState, useEffect, useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { AuthServiceUnavailableError, AuthTokenUnavailableError, authFetch } from "@/lib/api-auth-fetch";

export type WeeklyInsight = {
  id: string;
  weekStart: string;         // "YYYY-MM-DD"
  summary: string;           // 3-sentence Gemini narrative
  totalSpentUsd: string;     // e.g. "42.50"
  topCategory: string | null;
  balanceDeltaUsd: string;   // positive = balance grew, negative = shrank
  createdAt: string;
  updatedAt: string;
};

type State = {
  insight: WeeklyInsight | null;
  isLoading: boolean;
  isGenerating: boolean;
  error: string | null;
};

/** ISO date string of the most recent Monday (used to detect stale insights). */
function currentWeekStart(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

export function useWeeklyInsight() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [state, setState] = useState<State>({
    insight: null,
    isLoading: true,
    isGenerating: false,
    error: null,
  });

  const generate = useCallback(async () => {
    if (!ready || !authenticated) return;
    setState((s) => ({ ...s, isGenerating: true, error: null }));
    try {
      const res = await authFetch("/api/insights/weekly", { method: "POST" }, getAccessToken);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Generation failed");
      setState((s) => ({ ...s, insight: json.insight, isGenerating: false }));
    } catch (err: any) {
      if (err instanceof AuthTokenUnavailableError || err instanceof AuthServiceUnavailableError) {
        setState((s) => ({ ...s, isGenerating: false }));
        return;
      }
      setState((s) => ({
        ...s,
        isGenerating: false,
        error: err?.message ?? "Could not generate insight",
      }));
    }
  }, [ready, authenticated, getAccessToken]);

  // Fetch existing insight on mount; auto-generate if none exists for this week
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!ready) return;
      if (!authenticated) {
        setState((s) => ({ ...s, insight: null, isLoading: false, error: null }));
        return;
      }

      setState((s) => ({ ...s, isLoading: true, error: null }));
      try {
        const res = await authFetch("/api/insights/weekly", undefined, getAccessToken);
        const json = await res.json();
        if (cancelled) return;

        const insight: WeeklyInsight | null = json.insight;
        setState((s) => ({ ...s, insight, isLoading: false }));

        // Auto-generate if no insight yet, or the insight is from a previous week
        if (!insight || insight.weekStart !== currentWeekStart()) {
          // Don't await — let the generation run in the background
          if (!cancelled) generate();
        }
      } catch (err) {
        if (err instanceof AuthTokenUnavailableError || err instanceof AuthServiceUnavailableError) {
          if (!cancelled) setState((s) => ({ ...s, isLoading: false, error: null }));
          return;
        }
        if (!cancelled) {
          setState((s) => ({
            ...s,
            isLoading: false,
            error: "Could not load insight",
          }));
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [generate, ready, authenticated, getAccessToken]);

  return { ...state, generate };
}
