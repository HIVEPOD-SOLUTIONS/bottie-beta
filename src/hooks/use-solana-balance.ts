"use client";

import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";

// Mainnet USDC mint on Solana
const SOLANA_RPC = `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PRIVY_TOKEN = `solana:${USDC_MINT}`;

async function fetchPrivySolanaBalance(walletId: string): Promise<number> {
  const res = await fetch(
    `/api/balance?walletId=${encodeURIComponent(walletId)}&token=${encodeURIComponent(PRIVY_TOKEN)}`,
  );
  if (!res.ok) throw new Error("privy_failed");
  const data = await res.json();
  if (typeof data.formatted !== "string") throw new Error("privy_bad_response");
  return Number(data.formatted);
}

async function fetchWeb3jsSolanaBalance(address: string): Promise<number> {
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const owner = new PublicKey(address);
  const mint = new PublicKey(USDC_MINT);
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  return accounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
}

async function fetchRpcSolanaBalance(address: string): Promise<number> {
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [address, { mint: USDC_MINT }, { encoding: "jsonParsed" }],
    }),
  });
  const json = await res.json();
  const accounts = json?.result?.value ?? [];
  return accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
}

export function useSolanaBalance(address: string | undefined, walletId?: string) {
  const [balance, setBalance] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!address && !walletId) {
      setBalance(0);
      return;
    }

    let cancelled = false;

    async function fetchBalance() {
      setIsLoading(true);

      // Tier 1: Privy balance API
      if (walletId) {
        try {
          const bal = await fetchPrivySolanaBalance(walletId);
          if (!cancelled) { setBalance(bal); setIsLoading(false); }
          return;
        } catch {
          // fall through to tier 2
        }
      }

      // Tier 2: @solana/web3.js
      if (address) {
        try {
          const bal = await fetchWeb3jsSolanaBalance(address);
          if (!cancelled) { setBalance(bal); setIsLoading(false); }
          return;
        } catch {
          // fall through to tier 3
        }
      }

      // Tier 3: Raw RPC fetch
      if (address) {
        try {
          const bal = await fetchRpcSolanaBalance(address);
          if (!cancelled) setBalance(bal);
        } catch {
          // silently ignore — no further fallback
        }
      }

      if (!cancelled) setIsLoading(false);
    }

    fetchBalance();
    const interval = setInterval(fetchBalance, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [address, walletId]);

  const formatted = `$${balance.toFixed(2)}`;

  return { balance, formatted, isLoading };
}
