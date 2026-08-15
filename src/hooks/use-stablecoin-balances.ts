"use client";

/**
 * Fetches USDC + USDT balances across all supported EVM chains and Solana.
 *
 * Three-tier fallback — each tier covers both EVM and Solana together:
 *
 *   Tier 1 — Privy balance API (server-side proxy, no CSP issues)
 *             Requires PRIVY_APP_SECRET + Privy wallet IDs on the user object.
 *
 *   Tier 2 — viem readContract (EVM) + @solana/web3.js (Solana)
 *             Library abstractions querying Alchemy RPC endpoints.
 *
 *   Tier 3 — Raw Alchemy JSON-RPC (EVM eth_call + Solana getTokenAccountsByOwner)
 *             Most direct fallback; used when libraries themselves fail.
 *
 * If a tier throws or returns an error for any reason the next tier is tried
 * automatically. The hook never surfaces an error to the UI — it keeps the
 * last known good values while retrying on the next 30-second interval.
 */

import { useState, useEffect, useCallback } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { EVM_BALANCE_CHAINS, SOLANA_BALANCE_CHAIN } from "@/hooks/use-unified-balance";

// ── Constants ─────────────────────────────────────────────────────────────────
const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? "";

const EVM_RPC: Record<string, string> = {
  Base:      `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Ethereum:  `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Arbitrum:  `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Optimism:  `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Polygon:   `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Avalanche: `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
};

const ALCHEMY_SOL_RPC = `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const EVM_USDC: Record<string, string> = {
  Base:      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  Ethereum:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  Arbitrum:  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  Optimism:  "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  Polygon:   "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  Avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
};

const EVM_USDT: Record<string, string> = {
  Base:      "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  Ethereum:  "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  Arbitrum:  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  Optimism:  "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
  Polygon:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  Avalanche: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
};

const SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// ── Types ─────────────────────────────────────────────────────────────────────
export type StablecoinBalances = {
  evmUsdc:   number;
  evmUsdt:   number;
  solUsdc:   number;
  solUsdt:   number;
  isLoading: boolean;
};

type Balances = Omit<StablecoinBalances, "isLoading">;

// ── Tier 1: Privy balance API (server-side proxy) ─────────────────────────────
async function fetchViaPrivy(
  evmWalletId: string | null | undefined,
  solWalletId: string | null | undefined,
): Promise<Balances | null> {
  if (!evmWalletId && !solWalletId) return null;
  try {
    const params = new URLSearchParams();
    if (evmWalletId) params.set("evmWalletId", evmWalletId);
    if (solWalletId) params.set("solWalletId", solWalletId);
    const res = await fetch(`/api/balances/privy?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (
      typeof json.evmUsdc !== "number" ||
      typeof json.evmUsdt !== "number" ||
      typeof json.solUsdc !== "number" ||
      typeof json.solUsdt !== "number"
    ) return null;
    return { evmUsdc: json.evmUsdc, evmUsdt: json.evmUsdt, solUsdc: json.solUsdc, solUsdt: json.solUsdt };
  } catch {
    return null;
  }
}

// ── Tier 2: viem (EVM) + @solana/web3.js (Solana) ────────────────────────────
async function fetchViaLibraries(
  evmAddress: string | undefined,
  solAddress: string | undefined,
): Promise<Balances | null> {
  try {
    const { createPublicClient, http, erc20Abi } = await import("viem");
    const { Connection, PublicKey } = await import("@solana/web3.js");

    // EVM: readContract per chain (USDC + USDT) — all chains in parallel
    const evmResults = evmAddress
      ? await Promise.all(
          EVM_BALANCE_CHAINS.flatMap((chain) => {
            const rpc       = EVM_RPC[chain];
            const usdcAddr  = EVM_USDC[chain];
            const usdtAddr  = EVM_USDT[chain];
            if (!rpc) return [];
            const client = createPublicClient({ transport: http(rpc) });
            const readBal = (contractAddress: string | undefined) =>
              contractAddress
                ? client
                    .readContract({
                      address: contractAddress as `0x${string}`,
                      abi: erc20Abi,
                      functionName: "balanceOf",
                      args: [evmAddress as `0x${string}`],
                    })
                    .then((raw) => Number(raw) / 1e6)
                    .catch(() => 0)
                : Promise.resolve(0);
            return [
              readBal(usdcAddr).then((v) => ({ chain, token: "usdc", v })),
              readBal(usdtAddr).then((v) => ({ chain, token: "usdt", v })),
            ];
          }),
        )
      : [];

    let evmUsdc = 0;
    let evmUsdt = 0;
    for (const { token, v } of evmResults) {
      if (token === "usdc") evmUsdc += v;
      else evmUsdt += v;
    }

    // Solana: getParsedTokenAccountsByOwner via Alchemy Solana RPC
    let solUsdc = 0;
    let solUsdt = 0;
    if (solAddress) {
      const connection = new Connection(ALCHEMY_SOL_RPC, "confirmed");
      const owner = new PublicKey(solAddress);
      const [usdcAccounts, usdtAccounts] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(SOL_USDC_MINT) }).catch(() => ({ value: [] })),
        connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(SOL_USDT_MINT) }).catch(() => ({ value: [] })),
      ]);
      solUsdc = usdcAccounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
      solUsdt = usdtAccounts.value[0]?.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    }

    return { evmUsdc, evmUsdt, solUsdc, solUsdt };
  } catch {
    return null;
  }
}

// ── Tier 3: Raw Alchemy JSON-RPC (eth_call + Solana getTokenAccountsByOwner) ──
const BALANCE_OF_SELECTOR = "0x70a08231";

async function fetchViaAlchemyRPC(
  evmAddress: string | undefined,
  solAddress: string | undefined,
): Promise<Balances> {
  const fetchErc20 = async (rpc: string, contract: string, address: string): Promise<number> => {
    try {
      const padded = address.replace("0x", "").padStart(64, "0");
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: contract, data: `${BALANCE_OF_SELECTOR}${padded}` }, "latest"],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const json = await res.json();
      if (!json.result || json.result === "0x") return 0;
      return parseInt(json.result, 16) / 1e6;
    } catch { return 0; }
  };

  const fetchSplRaw = async (walletAddress: string, mintAddress: string): Promise<number> => {
    try {
      const res = await fetch(ALCHEMY_SOL_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenAccountsByOwner",
          params: [
            walletAddress,
            { mint: mintAddress },
            { encoding: "jsonParsed" },
          ],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const json = await res.json();
      const accounts = json?.result?.value ?? [];
      return accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    } catch { return 0; }
  };

  const [evmResults, solUsdc, solUsdt] = await Promise.all([
    evmAddress
      ? Promise.all(
          EVM_BALANCE_CHAINS.flatMap((chain) => {
            const rpc = EVM_RPC[chain];
            if (!rpc) return [];
            return [
              fetchErc20(rpc, EVM_USDC[chain]!, evmAddress).then((v) => ({ token: "usdc", v })),
              fetchErc20(rpc, EVM_USDT[chain]!, evmAddress).then((v) => ({ token: "usdt", v })),
            ];
          }),
        )
      : Promise.resolve([]),
    solAddress ? fetchSplRaw(solAddress, SOL_USDC_MINT) : Promise.resolve(0),
    solAddress ? fetchSplRaw(solAddress, SOL_USDT_MINT) : Promise.resolve(0),
  ]);

  let evmUsdc = 0;
  let evmUsdt = 0;
  for (const { token, v } of evmResults) {
    if (token === "usdc") evmUsdc += v;
    else evmUsdt += v;
  }

  return { evmUsdc, evmUsdt, solUsdc, solUsdt };
}

// ── DB snapshot loader ────────────────────────────────────────────────────────
// Reads the most recent balance snapshot from the database.
// Used to seed the UI instantly on mount (stale-while-revalidate).
async function loadLastSnapshot(): Promise<Balances | null> {
  try {
    const res = await fetch("/api/balances?limit=1", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const snap = json?.snapshots?.[0];
    if (!snap) return null;
    return {
      evmUsdc: parseFloat(snap.evmUsdc ?? "0"),
      evmUsdt: parseFloat(snap.evmUsdt ?? "0"),
      solUsdc: parseFloat(snap.solUsdc ?? "0"),
      solUsdt: parseFloat(snap.solUsdt ?? "0"),
    };
  } catch {
    return null;
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useStablecoinBalances(): StablecoinBalances {
  const { user } = usePrivy();
  const { wallets } = useWallets();

  // EVM address: prefer smart wallet, fall back to embedded EOA
  const smartWalletAddr = (user as any)?.smartWallet?.address as string | undefined;
  const eoaWallet = wallets.find(
    (w) => w.walletClientType === "privy" || (w as any).chainType === "ethereum",
  );
  const evmAddress = smartWalletAddr ?? eoaWallet?.address ?? (user as any)?.wallet?.address as string | undefined;

  // Solana address
  const accounts = (user?.linkedAccounts as any[]) ?? [];
  const solWalletFromAccounts = accounts.find(
    (a: any) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy",
  );
  const solWallet = wallets.find((w) => (w as any).chainType === "solana");
  const solAddress = solWallet?.address ?? solWalletFromAccounts?.address as string | undefined;

  // Privy wallet IDs for the server-side balance API
  const evmPrivyWalletId = (user?.wallet as any)?.id as string | null | undefined;
  const solPrivyWalletId = (solWalletFromAccounts ?? solWallet as any)?.id as string | null | undefined;

  const [balances, setBalances] = useState<Balances>({
    evmUsdc: 0, evmUsdt: 0, solUsdc: 0, solUsdt: 0,
  });
  // isLoading stays true until we have either a DB snapshot or a live fetch.
  const [isLoading, setIsLoading] = useState(true);

  // Stable dependency: only user.id changes on login/logout
  const userId = user?.id;

  // ── Live refresh (three-tier) ───────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!evmAddress && !solAddress) {
      if (userId) setIsLoading(false);
      return;
    }
    try {
      // Tier 1: Privy balance API
      const tier1 = await fetchViaPrivy(evmPrivyWalletId, solPrivyWalletId);
      if (tier1) {
        setBalances(tier1);
        persistSnapshot(evmAddress, solAddress, tier1);
        return;
      }

      // Tier 2: viem + @solana/web3.js
      console.warn("[balances] Privy API unavailable, trying viem/web3.js");
      const tier2 = await fetchViaLibraries(evmAddress, solAddress);
      if (tier2) {
        setBalances(tier2);
        persistSnapshot(evmAddress, solAddress, tier2);
        return;
      }

      // Tier 3: Raw Alchemy JSON-RPC
      console.warn("[balances] viem/web3.js failed, falling back to raw Alchemy RPC");
      const tier3 = await fetchViaAlchemyRPC(evmAddress, solAddress);
      setBalances(tier3);
      persistSnapshot(evmAddress, solAddress, tier3);
    } catch {
      // keep previous values on unexpected error
    } finally {
      setIsLoading(false);
    }
  }, [evmAddress, solAddress, userId, evmPrivyWalletId, solPrivyWalletId]);

  // ── Mount: seed from DB, then fetch live in background ─────────────────────
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Show last known balance from DB immediately — eliminates the $0 flash.
      const snapshot = await loadLastSnapshot();
      if (!cancelled && snapshot) {
        setBalances(snapshot);
        setIsLoading(false); // DB value is good enough to show; live fetch runs below
      }

      // Always run a live refresh on top of the DB seed.
      if (!cancelled) refresh();
    }

    init();
    const id = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  return { ...balances, isLoading };
}

// ── Snapshot persistence ──────────────────────────────────────────────────────
function persistSnapshot(
  evmAddress: string | undefined,
  solAddress: string | undefined,
  b: Balances,
) {
  fetch("/api/balances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      evmAddress: evmAddress ?? null,
      solAddress: solAddress ?? null,
      ...b,
    }),
  }).catch(() => {});
}
