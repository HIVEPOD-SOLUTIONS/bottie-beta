"use client";

/**
 * Shared XRP (sidebar wallet) balance.
 *
 * Previously the dashboard fetched this once on mount (page.tsx) and the
 * sidebar fetched it only when it opened — no polling, and nothing
 * refetched after the user moved XRP, so the low-balance banner and the
 * sidebar figure stayed stale until a reload. Stablecoin balances already
 * poll every 30s; this brings XRP in line and adds an explicit refresh for
 * moments the user knows the balance just changed.
 *
 * One module-level store + one poll regardless of how many components use
 * the hook, so the dashboard and the sidebar always agree.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authFetch } from "@/lib/api-auth-fetch";

const POLL_MS = 30_000;

type State = {
  userId: string | null;
  balance: number | null;
  /** True only until the first result — later refreshes don't flip it back, so the low-balance banner can't flash. */
  loading: boolean;
  /** bluvfi-xrpl no longer knows the wallet the app has on record. */
  orphaned: boolean;
};

const INITIAL: State = { userId: null, balance: null, loading: true, orphaned: false };
let state: State = INITIAL;
const listeners = new Set<() => void>();
let seq = 0; // only the newest request may write the store
// Every mounted hook registers its loader; they're interchangeable, so any
// one will do. A Set (not a single slot) so one instance unmounting can't
// silently disable refreshXrpBalance() while another is still mounted.
const loaders = new Set<(force: boolean) => Promise<void>>();
const runLoader = (force: boolean) => { const l = loaders.values().next().value; if (l) void l(force); };

function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * Call right after something that changes the sidebar wallet's XRP (a
 * transfer in or out, a recovery). Forces bluvfi-xrpl to re-check the
 * ledger instead of waiting for its next sweep. No-op if nothing has the
 * hook mounted.
 *
 * Checks twice: immediately, and again a few seconds later — the sending
 * side updates at once, but a deposit landing in the *destination* wallet
 * (e.g. a recovery back into the sidebar wallet) may not be recorded by
 * bluvfi-xrpl yet at the instant the transfer call returns.
 */
export function refreshXrpBalance() {
  runLoader(true);
  setTimeout(() => runLoader(true), 6_000);
}

export function useXrpBalance({ poll = true }: { poll?: boolean } = {}) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const userId = user?.id ?? null;
  const snapshot = useSyncExternalStore(subscribe, () => state, () => INITIAL);

  const load = useCallback(async (force: boolean) => {
    if (!ready || !authenticated) return;
    const mySeq = ++seq;
    try {
      const res = await authFetch(`/api/xrpl/balance${force ? "?refresh=1" : ""}`, undefined, getAccessToken);
      if (mySeq !== seq) return;
      if (res.ok) {
        const data = await res.json();
        if (mySeq !== seq) return;
        if (typeof data?.balanceXrp === "number") {
          setState({ balance: data.balanceXrp, orphaned: false, loading: false });
          return;
        }
      } else if (res.status === 404) {
        const data = await res.json().catch(() => null);
        if (mySeq !== seq) return;
        // ORPHANED: the app has a wallet on record that bluvfi-xrpl no
        // longer knows. NO_WALLET just means it hasn't been created yet.
        setState({ orphaned: data?.code === "ORPHANED", loading: false });
        return;
      }
      // Any other failure: keep the last known balance rather than
      // blanking it; just stop showing "loading" if we never had one.
      setState({ loading: false });
    } catch {
      if (mySeq !== seq) return;
      // Includes auth-not-ready: same as the old one-shot fetch, never
      // leave the low-balance check waiting on us forever — the next poll
      // tick retries.
      setState({ loading: false });
    }
  }, [ready, authenticated, getAccessToken]);

  // A different user (logout/login) must never see the previous user's balance.
  useEffect(() => {
    if (state.userId !== userId) {
      seq++;
      state = { ...INITIAL, userId };
      listeners.forEach((l) => l());
    }
  }, [userId]);

  useEffect(() => {
    loaders.add(load);
    return () => { loaders.delete(load); };
  }, [load]);

  useEffect(() => {
    if (!poll || !ready || !authenticated || !userId) return;
    void load(false);
    const tick = () => { if (document.visibilityState === "visible") void load(false); };
    const id = setInterval(tick, POLL_MS);
    // Catch up immediately when the app/tab returns to the foreground.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [poll, ready, authenticated, userId, load]);

  return {
    balance: snapshot.balance,
    loading: snapshot.loading,
    orphaned: snapshot.orphaned,
    refresh: () => load(true),
  };
}
