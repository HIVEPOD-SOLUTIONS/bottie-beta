"use client";

/**
 * PaymentsContext — single shared polling source for all payment data.
 *
 * Without this, every component that calls usePayments() runs its own
 * independent 5-second interval, resulting in 4+ simultaneous pollers
 * hammering /api/payments. This context lifts the fetch to a single
 * instance and shares the result via context.
 */

import { createContext, useContext, ReactNode } from "react";
import { usePayments, Payment } from "@/hooks/use-payments";

interface PaymentsContextValue {
  allPayments:  Payment[];
  billPayments: Payment[];
  loading:      boolean;
  error:        string | null;
  refetch:      () => void;
}

const PaymentsContext = createContext<PaymentsContextValue | null>(null);

export function PaymentsProvider({ children }: { children: ReactNode }) {
  // One poll for everything — components filter client-side.
  const { payments, loading, error, refetch } = usePayments();

  const billPayments = payments.filter((p) => p.type === "bill");

  return (
    <PaymentsContext.Provider value={{ allPayments: payments, billPayments, loading, error, refetch }}>
      {children}
    </PaymentsContext.Provider>
  );
}

export function usePaymentsContext() {
  const ctx = useContext(PaymentsContext);
  if (!ctx) throw new Error("usePaymentsContext must be used inside <PaymentsProvider>");
  return ctx;
}
