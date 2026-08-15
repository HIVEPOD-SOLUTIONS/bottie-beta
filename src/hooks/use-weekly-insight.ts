"use client";

/**
 * Fetches the latest weekly spending insight for the current user.
 *
 * On first mount — if no insight exists for the current week — it automatically
 * triggers generation via POST /api/insights/weekly (fire-and-forget; user
 * sees loading state then the fresh summary).
 */

import { useState, useEffect, useCallback } from "react";

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
  const [state, setState] = useState<State>({
    insight: null,
    isLoading: true,
    isGenerating: false,
    error: null,
  });

  const generate = useCallback(async () => {
    setState((s) => ({ ...s, isGenerating: true, error: null }));
    try {
      const res = await fetch("/api/insights/weekly", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Generation failed");
      setState((s) => ({ ...s, insight: json.insight, isGenerating: false }));
    } catch (err: any) {
      setState((s) => ({
        ...s,
        isGenerating: false,
        error: err?.message ?? "Could not generate insight",
      }));
    }
  }, []);

  // Fetch existing insight on mount; auto-generate if none exists for this week
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState((s) => ({ ...s, isLoading: true, error: null }));
      try {
        const res = await fetch("/api/insights/weekly");
        const json = await res.json();
        if (cancelled) return;

        const insight: WeeklyInsight | null = json.insight;
        setState((s) => ({ ...s, insight, isLoading: false }));

        // Auto-generate if no insight yet, or the insight is from a previous week
        if (!insight || insight.weekStart !== currentWeekStart()) {
          // Don't await — let the generation run in the background
          if (!cancelled) generate();
        }
      } catch {
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
  }, [generate]);

  return { ...state, generate };
}
