"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

const STORAGE_KEY = "bluvfi_v1";

export type PaymentRecord = {
  id: string;
  type: "bill" | "investment";
  description: string;
  amount: number;
  paidAt: string;
  usedNanopay?: boolean;
  txHash?: string | null;
  /** "evm" | "solana" — which network the payment settled on */
  chain?: string;
};

export type PortfolioPosition = {
  symbol: string;
  name: string;
  type: string;
  icon: string;
  shares: number;
  avgPriceUsd: number;
};

type State = {
  paidBillIds: string[];
  portfolio: PortfolioPosition[];
  payments: PaymentRecord[];
};

type CtxValue = State & {
  ready: boolean;
  isBillPaid: (id: string) => boolean;
  markBillPaid: (
    billId: string,
    amount: number,
    name: string,
    nanopay?: { usedNanopay?: boolean; txHash?: string | null; chain?: string }
  ) => void;
  buyAsset: (
    symbol: string,
    name: string,
    type: string,
    icon: string,
    shares: number,
    priceUsd: number,
    nanopay?: { usedNanopay?: boolean; txHash?: string | null; chain?: string }
  ) => void;
};

const DemoCtx = createContext<CtxValue | null>(null);

const DEFAULT: State = { paidBillIds: [], portfolio: [], payments: [] };

function load(): State {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return {
          paidBillIds: Array.isArray(parsed.paidBillIds) ? parsed.paidBillIds : [],
          portfolio:   Array.isArray(parsed.portfolio)   ? parsed.portfolio   : [],
          payments:    Array.isArray(parsed.payments)    ? parsed.payments    : [],
        };
      }
    }
  } catch {}
  return DEFAULT;
}

function persist(state: State) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function DemoStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(DEFAULT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setState(load());
    setReady(true);
  }, []);

  const update = useCallback((fn: (prev: State) => State) => {
    setState((prev) => {
      const next = fn(prev);
      persist(next);
      return next;
    });
  }, []);

  const markBillPaid = useCallback(
    (
      billId: string,
      amount: number,
      name: string,
      nanopay?: { usedNanopay?: boolean; txHash?: string | null; chain?: string }
    ) => {
      update((prev) => ({
        ...prev,
        paidBillIds: prev.paidBillIds.includes(billId)
          ? prev.paidBillIds
          : [...prev.paidBillIds, billId],
        payments: [
          {
            id: `bill_${billId}_${Date.now()}`,
            type: "bill",
            description: name,
            amount,
            paidAt: new Date().toISOString(),
            usedNanopay: nanopay?.usedNanopay,
            txHash: nanopay?.txHash,
            chain: nanopay?.chain ?? "evm",
          },
          ...prev.payments,
        ],
      }));
    },
    [update]
  );

  const buyAsset = useCallback(
    (
      symbol: string,
      name: string,
      type: string,
      icon: string,
      shares: number,
      priceUsd: number,
      nanopay?: { usedNanopay?: boolean; txHash?: string | null; chain?: string }
    ) => {
      update((prev) => {
        const existing = prev.portfolio.find((p) => p.symbol === symbol);
        let portfolio: PortfolioPosition[];
        if (existing) {
          const totalShares = existing.shares + shares;
          const avgPriceUsd =
            (existing.avgPriceUsd * existing.shares + priceUsd * shares) /
            totalShares;
          portfolio = prev.portfolio.map((p) =>
            p.symbol === symbol ? { ...p, shares: totalShares, avgPriceUsd } : p
          );
        } else {
          portfolio = [
            ...prev.portfolio,
            { symbol, name, type, icon, shares, avgPriceUsd: priceUsd },
          ];
        }
        return {
          ...prev,
          portfolio,
          payments: [
            {
              id: `inv_${symbol}_${Date.now()}`,
              type: "investment",
              description: `${shares} share${shares !== 1 ? "s" : ""} of ${symbol}`,
              amount: shares * priceUsd,
              paidAt: new Date().toISOString(),
              usedNanopay: nanopay?.usedNanopay,
              txHash: nanopay?.txHash,
              chain: nanopay?.chain ?? "evm",
            },
            ...prev.payments,
          ],
        };
      });
    },
    [update]
  );

  const isBillPaid = useCallback(
    (id: string) => state.paidBillIds.includes(id),
    [state.paidBillIds]
  );

  return (
    <DemoCtx.Provider
      value={{ ...state, ready, isBillPaid, markBillPaid, buyAsset }}
    >
      {children}
    </DemoCtx.Provider>
  );
}

export function useDemoState() {
  const ctx = useContext(DemoCtx);
  if (!ctx) throw new Error("Wrap with DemoStateProvider");
  return ctx;
}
