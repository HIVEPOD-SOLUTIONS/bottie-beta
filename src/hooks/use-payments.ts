"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export interface Payment {
  id: string;
  userId: string;
  type: string;
  referenceId: string | null;
  description: string;
  amountUsdc: string;
  status: string;
  txHash: string | null;
  chain: string | null;
  createdAt: string;
}

// Bitrefill invoices expire after 180 minutes. Any "pending" bill payment
// older than this is stale — mark it "failed" so it stops spinning.
const BITREFILL_EXPIRY_MS = 180 * 60 * 1_000; // 180 min

async function expireStalePayment(referenceId: string) {
  try {
    await fetch("/api/payments", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referenceId, status: "failed" }),
    });
  } catch {
    // best-effort
  }
}

export function usePayments(type?: "bill" | "investment") {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiredRef = useRef<Set<string>>(new Set());
  const syncedRef = useRef(false);

  const fetch_ = useCallback(async () => {
    setError(null);
    try {
      const url = type ? `/api/payments?type=${type}` : "/api/payments";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch payments");
      const data = await res.json();
      setPayments(data.payments ?? []);
    } catch (err: any) {
      setError(err?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  // When there are pending bill payments, sync their status against Bitrefill.
  // Runs once per "wave" of pending rows; resets when rows settle so a new wave triggers again.
  useEffect(() => {
    const pendingBills = payments.filter(
      (p) => p.status === "pending" && p.type === "bill",
    );
    if (pendingBills.length === 0) {
      // All settled — allow sync to run again if new pending rows appear later
      syncedRef.current = false;
      return;
    }
    if (syncedRef.current) return;
    syncedRef.current = true;

    fetch("/api/payments/sync", { method: "POST" })
      .then((res) => res.json())
      .then(() => fetch_())
      .catch(() => {
        syncedRef.current = false; // allow retry on network error
      });
  }, [payments, fetch_]);

  // Auto-expire stale pending payments (older than Bitrefill's 180-min invoice window)
  useEffect(() => {
    const now = Date.now();
    const stale = payments.filter(
      (p) =>
        p.status === "pending" &&
        p.referenceId &&
        !expiredRef.current.has(p.referenceId) &&
        p.createdAt &&
        now - new Date(p.createdAt).getTime() > BITREFILL_EXPIRY_MS,
    );
    for (const p of stale) {
      expiredRef.current.add(p.referenceId!);
      expireStalePayment(p.referenceId!).then(() => fetch_());
    }
  }, [payments, fetch_]);

  // Auto-poll every 5 s while any payment is still pending/processing.
  // Stops automatically once all settle to a terminal state.
  useEffect(() => {
    const hasPending = payments.some(
      (p) => p.status === "pending" || p.status === "processing",
    );

    if (hasPending && !pollRef.current) {
      pollRef.current = setInterval(fetch_, 5_000);
    }

    if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [payments, fetch_]);

  return { payments, loading, error, refetch: fetch_ };
}
