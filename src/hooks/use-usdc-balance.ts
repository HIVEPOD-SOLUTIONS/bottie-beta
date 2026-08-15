"use client";

import { useState, useEffect } from "react";
import { useBalance } from "wagmi";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const; // Base mainnet USDC
const PRIVY_TOKEN = "base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ALCHEMY_RPC = `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;

// balanceOf(address) selector
const BALANCE_OF_SELECTOR = "0x70a08231";

export const LOW_BALANCE_THRESHOLD_USD = 10;

async function fetchPrivyUsdcBalance(walletId: string): Promise<number> {
  const res = await fetch(
    `/api/balance?walletId=${encodeURIComponent(walletId)}&token=${encodeURIComponent(PRIVY_TOKEN)}`,
  );
  if (!res.ok) throw new Error("privy_failed");
  const data = await res.json();
  if (typeof data.formatted !== "string") throw new Error("privy_bad_response");
  return Number(data.formatted);
}

async function fetchRpcUsdcBalance(address: string): Promise<number> {
  // eth_call → ERC-20 balanceOf
  const paddedAddress = address.replace("0x", "").padStart(64, "0");
  const res = await fetch(ALCHEMY_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: USDC_BASE, data: `${BALANCE_OF_SELECTOR}${paddedAddress}` },
        "latest",
      ],
    }),
  });
  const json = await res.json();
  if (!json.result) throw new Error("rpc_failed");
  // USDC has 6 decimals
  return parseInt(json.result, 16) / 1e6;
}

export function useUsdcBalance(
  address: `0x${string}` | undefined,
  walletId?: string,
) {
  const [privyBalance, setPrivyBalance] = useState<number | null>(null);
  const [privyFailed, setPrivyFailed] = useState(false);
  const [rpcBalance, setRpcBalance] = useState<number | null>(null);

  // Tier 1: Privy balance API
  useEffect(() => {
    if (!walletId) return;
    let cancelled = false;

    async function run() {
      try {
        const bal = await fetchPrivyUsdcBalance(walletId!);
        if (!cancelled) { setPrivyBalance(bal); setPrivyFailed(false); }
      } catch {
        if (!cancelled) setPrivyFailed(true);
      }
    }

    run();
    const id = setInterval(run, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [walletId]);

  // Tier 3: Raw Alchemy RPC (only runs when both Privy and wagmi have failed/unavailable)
  useEffect(() => {
    if (!address || !privyFailed) return;
    let cancelled = false;

    async function run() {
      try {
        const bal = await fetchRpcUsdcBalance(address!);
        if (!cancelled) setRpcBalance(bal);
      } catch {
        // silently ignore — no further fallback
      }
    }

    run();
    const id = setInterval(run, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [address, privyFailed]);

  // Tier 2: wagmi useBalance (always mounted; used when Privy fails)
  const { data, isLoading: wagmiLoading, refetch } = useBalance({
    address,
    token: USDC_BASE,
  });
  const wagmiBalance = data ? Number(data.formatted) : null;

  // Priority: Privy → wagmi → RPC
  const usePrivyResult = !!walletId && !privyFailed && privyBalance !== null;
  const balance = usePrivyResult
    ? privyBalance
    : (wagmiBalance ?? rpcBalance ?? 0);

  const isLoading = usePrivyResult ? false : wagmiLoading;
  const isLow = !isLoading && balance > 0 && balance < LOW_BALANCE_THRESHOLD_USD;
  const formatted = `$${balance.toFixed(2)}`;

  return { balance, formatted, isLow, isLoading, refetch };
}
