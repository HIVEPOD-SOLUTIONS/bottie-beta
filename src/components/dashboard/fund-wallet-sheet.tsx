"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useWallets } from "@privy-io/react-auth";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { arcKit, AGENT_CHAIN, BRIDGE_SOURCE_OPTIONS, SOLANA_ARC_MAINNET_ENABLED } from "@/lib/arc-kit";
import type { BridgeSourceChain } from "@/lib/arc-kit";
import { UnifiedBalanceCard } from "./unified-balance-card";
import { useSolanaBalance } from "@/hooks/use-solana-balance";

// ─── Unified wallet option — merges the user's Privy embedded wallet with any
// injected (EIP-6963) browser wallets, so funding works with or without a
// separate extension like MetaMask ───────────────────────────────────────────

type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type WalletOption = {
  id: string;
  name: string;
  icon?: string;
  address?: string; // pre-known for the Privy embedded wallet
  provider: WalletProvider;
};

type EIP6963ProviderDetail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: WalletProvider;
};

function useFundingWallets() {
  const { wallets: privyWallets } = useWallets();
  const [discovered, setDiscovered] = useState<EIP6963ProviderDetail[]>([]);
  const [connected, setConnected] = useState<{
    option: WalletOption;
    address: string;
  } | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const map = new Map<string, EIP6963ProviderDetail>();

    const onAnnounce = (e: Event) => {
      const { detail } = e as CustomEvent<EIP6963ProviderDetail>;
      map.set(detail.info.uuid, detail);
      setDiscovered([...map.values()]);
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  const options: WalletOption[] = useMemo(() => {
    const privyOptions: WalletOption[] = privyWallets
      .filter((w) => w.walletClientType === "privy")
      .map((w) => ({
        id: `privy-${w.address}`,
        name: "Bluvfi Wallet",
        address: w.address,
        provider: {
          request: async (args) => {
            const provider = await w.getEthereumProvider();
            return provider.request(args);
          },
        },
      }));

    const injectedOptions: WalletOption[] = discovered.map((d) => ({
      id: d.info.uuid,
      name: d.info.name,
      icon: d.info.icon,
      provider: d.provider,
    }));

    return [...privyOptions, ...injectedOptions];
  }, [privyWallets, discovered]);

  const connect = useCallback(async (option: WalletOption) => {
    if (option.address) {
      setConnected({ option, address: option.address });
      return;
    }
    setConnecting(true);
    try {
      await option.provider.request({ method: "eth_requestAccounts" });
      const accounts = (await option.provider.request({
        method: "eth_accounts",
      })) as string[];
      setConnected({ option, address: accounts[0] ?? "" });
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => setConnected(null), []);

  return { options, connected, connect, disconnect, connecting };
}

// ─── Shared state types ───────────────────────────────────────────────────────

type TxState =
  | { status: "idle" }
  | { status: "pending"; label: string }
  | { status: "success"; explorerUrl?: string }
  | { status: "error"; message: string };

// ─── Copy-to-clipboard helper ─────────────────────────────────────────────────

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return { copied, copy };
}

// ─── Wallet selector ──────────────────────────────────────────────────────────

function WalletSelector({
  options,
  connected,
  onConnect,
  onDisconnect,
  connecting,
}: {
  options: WalletOption[];
  connected: { option: WalletOption; address: string } | null;
  onConnect: (option: WalletOption) => void;
  onDisconnect: () => void;
  connecting: boolean;
}) {
  if (connected) {
    return (
      <div className="flex items-center justify-between rounded-xl bg-[#141513] border border-[#2A2B27] px-4 py-3">
        <div className="flex items-center gap-2.5">
          {connected.option.icon && (
            <img src={connected.option.icon} alt="" className="h-6 w-6 rounded" />
          )}
          <div>
            <p className="text-xs font-medium text-[#F2F0E8]">{connected.option.name}</p>
            <p className="text-[10px] text-[#A7A79A] font-mono">
              {connected.address.slice(0, 6)}…{connected.address.slice(-4)}
            </p>
          </div>
        </div>
        <button
          onClick={onDisconnect}
          className="text-xs text-[#A7A79A] hover:text-[#F2F0E8]"
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="rounded-xl bg-[#141513] border border-[#2A2B27] px-4 py-3 text-sm text-[#A7A79A]">
        No wallets available.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onConnect(option)}
          disabled={connecting}
          className="flex items-center gap-3 rounded-xl bg-[#141513] border border-[#2A2B27] px-4 py-3 text-left disabled:opacity-50"
        >
          {option.icon ? (
            <img src={option.icon} alt="" className="h-8 w-8 rounded" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#8FAE82]/20 text-sm">
              🤖
            </div>
          )}
          <div className="flex-1">
            <p className="text-sm font-medium text-[#F2F0E8]">{option.name}</p>
            <p className="text-xs text-[#A7A79A]">
              {option.address ? "Your Bluvfi wallet" : "Click to connect"}
            </p>
          </div>
          <span className="text-[#8FAE82] text-xs font-medium">
            {option.address ? "Use →" : "Connect →"}
          </span>
        </button>
      ))}
    </div>
  );
}

// ─── Transaction result banner ────────────────────────────────────────────────

function TxResult({ state, onReset }: { state: TxState; onReset: () => void }) {
  if (state.status === "idle") return null;
  if (state.status === "pending") {
    return (
      <div className="rounded-xl bg-blue-900/20 border border-blue-900/40 px-4 py-3 text-sm text-blue-300">
        ⏳ {state.label}
      </div>
    );
  }
  if (state.status === "success") {
    return (
      <div className="rounded-xl bg-green-900/20 border border-green-900/40 px-4 py-3 text-sm text-green-400">
        ✓ Transfer complete!{" "}
        {state.explorerUrl && (
          <span className="text-[#A7A79A] text-xs">(confirmed on-chain)</span>
        )}
        <button onClick={onReset} className="ml-3 text-xs underline">
          New transfer
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-xl bg-red-900/20 border border-red-900/40 px-4 py-3 text-sm text-red-400">
      {state.message}
      <button onClick={onReset} className="ml-3 text-xs underline">
        Try again
      </button>
    </div>
  );
}

// ─── Send tab ─────────────────────────────────────────────────────────────────

function SendTab({ agentAddress }: { agentAddress: string }) {
  const { options, connected, connect, disconnect, connecting } = useFundingWallets();
  const { copied, copy } = useCopy(agentAddress);
  const [amount, setAmount] = useState("");
  const [txState, setTxState] = useState<TxState>({ status: "idle" });

  const handleSend = async () => {
    if (!connected || !amount || Number(amount) <= 0 || txState.status === "pending") return;
    setTxState({ status: "pending", label: "Preparing transfer…" });
    try {
      const adapter = await createViemAdapterFromProvider({
        provider: connected.option.provider as Parameters<typeof createViemAdapterFromProvider>[0]["provider"],
      });

      setTxState({ status: "pending", label: "Confirm in your wallet…" });
      const result = await arcKit.send({
        from: { adapter, chain: AGENT_CHAIN },
        to: agentAddress,
        amount,
        token: "USDC",
      });

      const sendSuccess = result.state === "success";
      setTxState({
        status: sendSuccess ? "success" : "error",
        explorerUrl: (result as any).explorerUrl,
        message: !sendSuccess ? "Transfer could not be completed." : "",
      } as TxState);

      // Persist the send to the payments ledger
      if (sendSuccess) {
        fetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "transfer",
            referenceId: (result as any).hash ?? (result as any).transactionHash ?? null,
            description: `Arc send: ${amount} USDC → agent wallet`,
            amountUsdc: amount,
            status: "completed",
            txHash: (result as any).hash ?? (result as any).transactionHash ?? null,
            chain: "evm",
          }),
        }).catch(() => {});
      }
    } catch (err: any) {
      const msg = err?.message ?? "";
      setTxState({
        status: "error",
        message: msg.includes("rejected") || msg.includes("denied")
          ? "Transfer cancelled."
          : "Transfer could not be completed. Please check your balance and try again.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Address display */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">Your wallet address</p>
        <div className="flex items-center gap-2 rounded-xl bg-[#141513] border border-[#2A2B27] px-4 py-3">
          <p className="flex-1 font-mono text-xs text-[#F2F0E8] truncate">{agentAddress}</p>
          <button
            onClick={copy}
            className="shrink-0 rounded-lg bg-[#8FAE82]/20 px-3 py-1 text-xs font-medium text-[#8FAE82]"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-[#A7A79A]">
          Share this address to receive funds from any wallet on Base.
        </p>
      </div>

      <div className="relative flex items-center">
        <div className="flex-1 border-t border-[#2A2B27]" />
        <span className="mx-3 text-xs text-[#A7A79A]">or send directly</span>
        <div className="flex-1 border-t border-[#2A2B27]" />
      </div>

      {/* Wallet selector */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">
          Choose a wallet (Base)
        </p>
        <WalletSelector
          options={options}
          connected={connected}
          onConnect={connect}
          onDisconnect={disconnect}
          connecting={connecting}
        />
      </div>

      {connected && (
        <>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#A7A79A]">
              Amount (USDC)
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10.00"
              className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder:text-[#A7A79A]/50 outline-none focus:border-[#8FAE82]"
            />
          </div>

          <TxResult state={txState} onReset={() => setTxState({ status: "idle" })} />

          {txState.status !== "success" && (
            <button
              onClick={handleSend}
              disabled={!amount || Number(amount) <= 0 || txState.status === "pending"}
              className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-50"
            >
              {txState.status === "pending" ? txState.label : `Send $${amount || "0.00"}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ─── Bridge tab ───────────────────────────────────────────────────────────────

function BridgeTab({ agentAddress }: { agentAddress: string }) {
  const { options, connected, connect, disconnect, connecting } = useFundingWallets();
  const [sourceChain, setSourceChain] = useState<BridgeSourceChain>(
    BRIDGE_SOURCE_OPTIONS[0].value
  );
  const [amount, setAmount] = useState("");
  const [txState, setTxState] = useState<TxState>({ status: "idle" });

  const selectedSource = BRIDGE_SOURCE_OPTIONS.find((o) => o.value === sourceChain)!;

  const handleBridge = async () => {
    if (!connected || !amount || Number(amount) <= 0 || txState.status === "pending") return;
    setTxState({ status: "pending", label: "Preparing bridge…" });
    try {
      const adapter = await createViemAdapterFromProvider({
        provider: connected.option.provider as Parameters<typeof createViemAdapterFromProvider>[0]["provider"],
      });

      setTxState({ status: "pending", label: "Confirm in your wallet…" });
      const result = await arcKit.bridge({
        from: { adapter, chain: sourceChain },
        to: {
          adapter,
          chain: AGENT_CHAIN,
          recipientAddress: agentAddress,
        },
        amount,
        token: "USDC",
      });

      const bridgeSuccess = result.state === "success";
      setTxState({
        status: bridgeSuccess ? "success" : "error",
        explorerUrl: (result as any).explorerUrl,
        message: !bridgeSuccess ? "Bridge could not be completed." : "",
      } as TxState);

      // Persist bridge transaction
      if (bridgeSuccess) {
        fetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "bridge",
            referenceId: (result as any).hash ?? (result as any).transactionHash ?? null,
            description: `Arc bridge: ${amount} USDC from ${selectedSource.label} → Base`,
            amountUsdc: amount,
            status: "completed",
            txHash: (result as any).hash ?? (result as any).transactionHash ?? null,
            chain: "evm",
          }),
        }).catch(() => {});
      }
    } catch (err: any) {
      const msg = err?.message ?? "";
      setTxState({
        status: "error",
        message: msg.includes("rejected") || msg.includes("denied")
          ? "Bridge cancelled."
          : "Bridge could not be completed. Check that you have sufficient balance on the source network.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Info blurb */}
      <div className="rounded-xl bg-[#141513] border border-[#2A2B27] px-4 py-3 text-xs text-[#A7A79A] leading-relaxed">
        Bridge moves funds from another network into your wallet on Base automatically — no manual steps needed.
      </div>

      {/* Source chain selector */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-[#A7A79A]">
          From network
        </label>
        <div className="flex flex-wrap gap-2">
          {BRIDGE_SOURCE_OPTIONS.map((opt) => (
            <div key={opt.value} className="relative group">
              <button
                onClick={() => !opt.disabled && setSourceChain(opt.value as BridgeSourceChain)}
                disabled={opt.disabled}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  opt.disabled
                    ? "cursor-not-allowed opacity-40 bg-white/[0.03] text-[#A7A79A]"
                    : sourceChain === opt.value
                    ? "bg-[#F2F0E8] text-[#141513]"
                    : "bg-white/[0.06] text-[#A7A79A] hover:bg-white/[0.10]"
                }`}
              >
                <span>{opt.icon}</span>
                {opt.label}
                {opt.disabled && (
                  <span className="ml-1 rounded px-1 py-0.5 text-[9px] font-semibold bg-[#9945FF]/20 text-[#9945FF] leading-none">
                    MAINNET
                  </span>
                )}
              </button>
              {/* Tooltip shown on hover when disabled */}
              {opt.disabled && (
                <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-[#1E1F1B] border border-[#2A2B27] px-3 py-1.5 text-[11px] text-[#A7A79A] opacity-0 group-hover:opacity-100 transition-opacity z-50">
                  {SOLANA_ARC_MAINNET_ENABLED
                    ? "Not available"
                    : "Available on Solana mainnet"}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Destination display */}
      <div className="flex items-center justify-between rounded-xl bg-[#141513] border border-[#2A2B27] px-4 py-3">
        <div>
          <p className="text-xs text-[#A7A79A]">To network</p>
          <p className="text-sm font-medium text-[#F2F0E8]">🔷 Base</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-[#A7A79A]">Recipient</p>
          <p className="font-mono text-xs text-[#F2F0E8]">Your wallet</p>
        </div>
      </div>

      {/* Wallet selector */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">
          Choose a wallet on {selectedSource.label}
        </p>
        <WalletSelector
          options={options}
          connected={connected}
          onConnect={connect}
          onDisconnect={disconnect}
          connecting={connecting}
        />
      </div>

      {connected && (
        <>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[#A7A79A]">
              Amount (USDC)
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="50.00"
              className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder:text-[#A7A79A]/50 outline-none focus:border-[#8FAE82]"
            />
          </div>

          <TxResult state={txState} onReset={() => setTxState({ status: "idle" })} />

          {txState.status !== "success" && (
            <button
              onClick={handleBridge}
              disabled={!amount || Number(amount) <= 0 || txState.status === "pending"}
              className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-50"
            >
              {txState.status === "pending"
                ? txState.label
                : `Bridge $${amount || "0.00"} → Base`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ─── Solana receive tab ───────────────────────────────────────────────────────

function SolanaReceiveTab({ solanaAddress }: { solanaAddress: string }) {
  const { wallets } = useWallets();
  const solWallet = wallets.find((w) => (w as any).chainType === "solana") as any;
  const { balance, isLoading } = useSolanaBalance(solanaAddress, solWallet?.id);
  const { copied, copy } = useCopy(solanaAddress);

  return (
    <div className="flex flex-col gap-4">
      {/* Balance */}
      <div className="rounded-2xl bg-[#141513] border border-[#2A2B27] px-5 py-4">
        <p className="text-xs text-[#A7A79A] font-medium">Solana USDC Balance</p>
        <p className="mt-1 text-2xl font-bold text-[#F2F0E8]">
          {isLoading ? (
            <span className="text-base text-[#A7A79A]">Loading…</span>
          ) : (
            `$${balance.toFixed(2)}`
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-[#A7A79A]">Mainnet USDC (◎ Solana)</p>
      </div>

      {/* Address card */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">Your Solana wallet address</p>
        <div className="flex items-center gap-2 rounded-xl bg-[#141513] border border-[#2A2B27] px-4 py-3">
          <p className="flex-1 font-mono text-xs text-[#F2F0E8] truncate">{solanaAddress}</p>
          <button
            onClick={copy}
            className="shrink-0 rounded-lg bg-[#9945FF]/20 px-3 py-1 text-xs font-medium text-[#9945FF]"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      {/* Instructions */}
      <div className="rounded-xl bg-[#9945FF]/[0.06] border border-[#9945FF]/20 px-4 py-3 space-y-2">
        <p className="text-xs font-semibold text-[#9945FF]">◎ Fund your Solana wallet</p>
        <ul className="space-y-1 text-xs text-[#A7A79A] list-disc list-inside">
          <li>Send <strong className="text-[#F2F0E8]">USDC on Solana mainnet</strong> to the address above</li>
          <li>From Phantom, Backpack, Coinbase Wallet, or any Solana wallet</li>
          <li>Only send USDC — other tokens won&apos;t be used for payments</li>
          <li>Balance updates automatically every 30 seconds</li>
        </ul>
      </div>

      {/* Refresh hint */}
      <p className="text-center text-[11px] text-[#A7A79A]">
        Sent funds? Wait 10–30 seconds for confirmation, then balance updates automatically.
      </p>
    </div>
  );
}

// ─── Main exported component ──────────────────────────────────────────────────

interface FundWalletSheetProps {
  agentAddress: string;
  /** User's Privy Solana wallet address — when provided, a Solana receive tab is shown */
  solanaAddress?: string;
  onClose: () => void;
}

export function FundWalletSheet({ agentAddress, solanaAddress, onClose }: FundWalletSheetProps) {
  type Tab = "balances" | "send" | "bridge" | "solana";
  const [tab, setTab] = useState<Tab>("balances");

  const TABS: { key: Tab; label: string }[] = [
    { key: "balances", label: "⊞ Balances" },
    { key: "send",     label: "↗ Send"     },
    { key: "bridge",   label: "⇌ Bridge"   },
    ...(solanaAddress ? [{ key: "solana" as Tab, label: "◎ Solana" }] : []),
  ];

  const sheet = (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-t-3xl bg-[#1B1C19] border-t border-[#2A2B27] flex flex-col max-h-[90dvh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h3 className="text-lg font-semibold text-[#F2F0E8]">Wallet</h3>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-[#A7A79A] hover:bg-white/[0.06]"
          >
            ✕
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-2 px-6 pb-4 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 flex-1 min-w-fit rounded-full py-2 px-3 text-xs font-medium transition-colors ${
                tab === t.key
                  ? t.key === "solana"
                    ? "bg-[#9945FF] text-white"
                    : "bg-[#F2F0E8] text-[#141513]"
                  : "bg-white/[0.06] text-[#A7A79A]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto px-6 pb-10 flex-1">
          {tab === "balances" && (
            <UnifiedBalanceCard onBridge={() => setTab("bridge")} />
          )}
          {tab === "send"     && <SendTab agentAddress={agentAddress} />}
          {tab === "bridge"   && <BridgeTab agentAddress={agentAddress} />}
          {tab === "solana"   && solanaAddress && (
            <SolanaReceiveTab solanaAddress={solanaAddress} />
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(sheet, document.body);
}
