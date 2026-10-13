"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { arcChain, ARC_USDC } from "@/lib/arc-chain";

/**
 * The user's USDC on Arc mainnet (wallet balance, 6-dp ERC-20 view). Kept
 * separate from useStablecoinBalances' cross-chain totals so it can be shown
 * on its own line. On Arc this same USDC also pays gas.
 */
export function useArcUsdcBalance(pollMs = 30_000) {
  const { wallets } = useWallets();
  const address = (wallets.find((w) => w.walletClientType === "privy") ?? wallets[0])?.address as Hex | undefined;
  const [balance, setBalance] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const client = createPublicClient({ chain: arcChain, transport: http() });
      const raw = await client.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
      setBalance(Number(raw) / 1e6);
    } catch {
      // Keep the last known value on a transient RPC error.
    }
  }, [address]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  return { arcUsdc: balance, address, refresh };
}
