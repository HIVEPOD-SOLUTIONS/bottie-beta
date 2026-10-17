"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  parseUnits,
  type Chain,
  type Hex,
} from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import type { ConnectedWallet, usePrivy } from "@privy-io/react-auth";
import { domaChain } from "@/lib/doma-chain";
import { arcChain } from "@/lib/arc-chain";
import { PRIVY_SPONSORED_CHAIN_IDS } from "@/lib/sponsor-chains";
import { robinhoodChain, tempoChain } from "@/lib/swap-chains";

/**
 * Every EVM payment from the user's Privy wallet goes through here, so all
 * providers get the same fallback:
 *
 *   Layer 1 — Privy native gas sponsorship, relayed through
 *             /api/privy/sponsored-send (user-pays mode: gas in the wallet's
 *             USDC); needs the chain enabled in the Privy dashboard
 *             (Wallet infrastructure → Gas management).
 *   Layer 2 — The same Privy wallet as a plain EOA; the user pays gas in the
 *             chain's native token. Skipped if they have none.
 *   Layer 3 — Circle ArcKit send (Circle sponsors gas; the Privy wallet
 *             signs). Plain token/ETH transfers only, on chains ArcKit knows.
 *
 * If the user rejects a prompt, we stop — never re-prompt them on the next
 * layer. Contract calls (approve, Seaport fills, Doma pay) use Layers 1–2.
 */

export type SendTransaction = ReturnType<typeof usePrivy>["sendTransaction"];
export type PayLayer = 1 | 2 | 3;

const ALCHEMY_SUBDOMAIN: Record<number, string> = {
  1: "eth-mainnet", 8453: "base-mainnet", 137: "polygon-mainnet", 42161: "arb-mainnet", 10: "opt-mainnet",
};

const CHAINS: Record<number, Chain> = {
  1: mainnet, 8453: base, 137: polygon, 42161: arbitrum, 10: optimism, [domaChain.id]: domaChain, [arcChain.id]: arcChain,
  [robinhoodChain.id]: robinhoodChain, [tempoChain.id]: tempoChain,
};

// ArcKit's Blockchain enum values for the chains it supports (Layer 3).
// Arc mainnet needs @circle-fin/app-kit ≥ 1.15.
const ARCKIT_CHAINS: Record<number, string> = {
  1: "Ethereum", 8453: "Base", 137: "Polygon", 42161: "Arbitrum", 10: "Optimism", [arcChain.id]: "Arc",
};

// USDT's transfer() on some chains returns nothing — a stripped ABI avoids decode errors.
const TRANSFER_NO_RETURN = parseAbi(["function transfer(address to, uint256 amount)"]);

export function evmChain(chainId: number): Chain {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`Chain ${chainId} isn't supported for wallet payments.`);
  return c;
}

/** Public client on a CSP-allowed RPC (Alchemy where we have it, else the chain's own). */
export function evmPublicClient(chainId: number) {
  const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  const sub = ALCHEMY_SUBDOMAIN[chainId];
  return createPublicClient({ chain: evmChain(chainId), transport: http(key && sub ? `https://${sub}.g.alchemy.com/v2/${key}` : undefined) });
}

export function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number; message?: string; shortMessage?: string; cause?: { code?: number } } | null;
  if (e?.code === 4001 || e?.cause?.code === 4001) return true;
  return /user rejected|rejected the request|denied|cancel/i.test(`${e?.shortMessage ?? ""} ${e?.message ?? ""}`);
}

/** One-line, user-facing version of a wallet/RPC error. */
export function friendlyEvmError(err: unknown, chainName = "this network"): string {
  if (isUserRejection(err)) return "Cancelled. Nothing was sent.";
  const raw = (err as Error)?.message ?? String(err);
  const m = raw.toLowerCase();
  if (m.includes("insufficient funds for gas") || m.includes("gas required exceeds") || m.includes("no native gas")) return `Not enough gas on ${chainName}.`;
  if (m.includes("insufficient token balance") || m.includes("balance_insufficient") || m.includes("exceeds balance") || m.includes("invalid opcode")) {
    return `Not enough balance on ${chainName}.`;
  }
  return raw.split("\n")[0];
}

export interface EvmPayment {
  chainId: number;
  /** Contract call or plain value transfer. */
  to: Hex;
  data?: Hex;
  value?: bigint;
  /**
   * Set for plain token/ETH transfers so Layer 3 (ArcKit) can do it.
   * amount is a decimal string in token units ("12.5").
   */
  transfer?: { token: Hex | "native"; recipient: Hex; amount: string; symbol?: string };
}

/**
 * Sends one EVM transaction through Layers 1 → 2 → 3 and returns its hash and
 * the layer that succeeded. Does not wait for confirmation (see waitForEvmTx).
 */
export async function payEvm(opts: {
  payment: EvmPayment;
  wallet: ConnectedWallet;
  sendTransaction: SendTransaction;
  onLayer?: (layer: PayLayer) => void;
  /** Tag for console logs, e.g. "bitrefill". */
  label?: string;
}): Promise<{ hash: Hex; layer: PayLayer }> {
  const { payment, wallet, onLayer, label = "pay" } = opts;
  const chain = evmChain(payment.chainId);
  const tx = { to: payment.to, chainId: payment.chainId, ...(payment.data ? { data: payment.data } : {}), ...(payment.value ? { value: payment.value } : {}) };
  let lastErr: unknown;

  // ── Layer 1: Privy gas sponsorship (only where Privy supports user-pays USDC gas; not Arc) ──
  if (PRIVY_SPONSORED_CHAIN_IDS.has(payment.chainId)) {
    try {
      onLayer?.(1);
      // The app is in Privy's "User pays" gas mode, which needs `sponsor_options` — client SDKs
      // can't pass it, so relay through the server (gas is paid in the wallet's USDC).
      const res = await fetch("/api/privy/sponsored-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ chainId: payment.chainId, to: payment.to, data: payment.data, value: payment.value?.toString() }),
      });
      const json = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
      if (!res.ok || !json.hash) throw new Error(json.error ?? `Sponsored send failed (HTTP ${res.status})`);
      return { hash: json.hash as Hex, layer: 1 };
    } catch (err) {
      if (isUserRejection(err)) throw err;
      lastErr = err;
      console.warn(`[${label}] Layer 1 (sponsored) failed on ${chain.name}:`, friendlyEvmError(err, chain.name));
    }
  }

  // ── Layer 2: plain EOA, user pays gas ──
  try {
    onLayer?.(2);
    const account = wallet.address as Hex;
    // Privy's confirm UI estimates gas in an unawaited promise that throws if
    // the wallet has no native token — check first so we fail cleanly.
    // Tempo has no native gas token (fees are paid in a stablecoin), so there is no balance to check.
    if (payment.chainId !== tempoChain.id) {
      // If the RPC itself is unreachable (ad blocker, CSP, outage) we can't tell, so let the wallet try.
      const gas = await evmPublicClient(payment.chainId).getBalance({ address: account }).catch(() => null);
      if (gas === BigInt(0)) throw new Error(`No native gas: no ${chain.nativeCurrency.symbol} on ${chain.name}`);
    }
    await wallet.switchChain(payment.chainId);
    const provider = await wallet.getEthereumProvider();
    // switchChain can resolve without the provider following (seen on Arc); never send on the wrong chain.
    let active = Number(await provider.request({ method: "eth_chainId" }));
    if (active !== payment.chainId) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${payment.chainId.toString(16)}` }] });
      active = Number(await provider.request({ method: "eth_chainId" }));
    }
    if (active !== payment.chainId) throw new Error(`Couldn't switch the wallet to ${chain.name}.`);
    const client = createWalletClient({ account, chain, transport: custom(provider) });
    const hash = await client.sendTransaction({ account, chain, to: payment.to, data: payment.data, value: payment.value });
    return { hash, layer: 2 };
  } catch (err) {
    if (isUserRejection(err)) throw err;
    lastErr = err;
    console.warn(`[${label}] Layer 2 (user gas) failed on ${chain.name}:`, friendlyEvmError(err, chain.name));
  }

  // ── Layer 3: Circle ArcKit (transfers only) ──
  const arcChain = ARCKIT_CHAINS[payment.chainId];
  if (payment.transfer && arcChain) {
    onLayer?.(3);
    const [{ arcKit }, { createViemAdapterFromProvider }] = await Promise.all([
      import("@/lib/arc-kit"),
      import("@circle-fin/adapter-viem-v2"),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = await createViemAdapterFromProvider({ provider: (await wallet.getEthereumProvider()) as any });
    const t = payment.transfer;
    // ArcKit only knows the "USDT" alias on Ethereum; elsewhere pass the contract address.
    const token = t.token === "native" ? "NATIVE" : t.symbol === "USDC" ? "USDC" : t.symbol === "USDT" && payment.chainId === 1 ? "USDT" : t.token;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const step = await arcKit.send({ from: { adapter, chain: arcChain as any }, to: t.recipient, amount: t.amount, token: token as any });
      if (step.state === "error" || !step.txHash) throw new Error("Transfer did not complete");
      return { hash: step.txHash as Hex, layer: 3 };
    } catch (err) {
      if (isUserRejection(err)) throw err;
      console.warn(`[${label}] Layer 3 (ArcKit) failed on ${chain.name}:`, friendlyEvmError(err, chain.name));
      throw new Error(friendlyEvmError(err, chain.name));
    }
  }

  throw new Error(friendlyEvmError(lastErr, chain.name));
}

/** Builds and sends an ERC-20 or native transfer (all three layers). */
export function payEvmTransfer(opts: {
  chainId: number;
  token: Hex | "native";
  /** Token symbol — USDT gets the no-return transfer ABI; USDC/USDT aliases help ArcKit. */
  symbol: string;
  decimals: number;
  recipient: Hex;
  amount: string;
  wallet: ConnectedWallet;
  sendTransaction: SendTransaction;
  onLayer?: (layer: PayLayer) => void;
  label?: string;
}) {
  const { chainId, token, symbol, decimals, recipient, amount, ...rest } = opts;
  const atomic = parseUnits(amount, decimals);
  const payment: EvmPayment = token === "native"
    ? { chainId, to: recipient, value: atomic, transfer: { token, recipient, amount, symbol } }
    : {
        chainId,
        to: token,
        data: encodeFunctionData({ abi: symbol === "USDT" ? TRANSFER_NO_RETURN : erc20Abi, functionName: "transfer", args: [recipient, atomic] }),
        transfer: { token, recipient, amount, symbol },
      };
  return payEvm({ payment, ...rest });
}

/** Waits for a transaction and throws if it reverted. */
export async function waitForEvmTx(chainId: number, hash: Hex) {
  // Bounded: if the RPC is blocked/unreachable, polling would otherwise spin forever and leave the UI "busy".
  const receipt = await evmPublicClient(chainId).waitForTransactionReceipt({ hash, timeout: 90_000 }).catch((err) => {
    if ((err as Error)?.name === "WaitForTransactionReceiptTimeoutError") {
      throw new Error(`Sent (${hash.slice(0, 10)}…), but couldn't confirm it — the network RPC may be blocked. Check your balance in a minute.`);
    }
    throw err;
  });
  if (receipt.status !== "success") throw new Error("The transaction failed on-chain. Nothing was charged.");
  return receipt;
}

/** Privy embedded wallet first, else any connected EVM wallet. */
export function pickPrivyWallet(wallets: ConnectedWallet[]): ConnectedWallet | undefined {
  return wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
}

export function pickPrivyWalletOrThrow(wallets: ConnectedWallet[]): ConnectedWallet {
  const w = pickPrivyWallet(wallets);
  if (!w) throw new Error("No wallet connected.");
  return w;
}
