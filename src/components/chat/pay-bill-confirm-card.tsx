"use client";

import { useState, useCallback, useEffect } from "react";
import { useWallets } from "@privy-io/react-auth";
import { arcKit, AGENT_CHAIN, SOLANA_ARC_CHAIN } from "@/lib/arc-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { useDemoState } from "@/contexts/demo-state-context";

const EVM_RECEIVER = "0x9404966338eB27aF420a952574d777598Bbb58c4" as const;
const SOL_RECEIVER = process.env.NEXT_PUBLIC_SOLANA_BILL_RECEIVER ?? "";

type Network = "evm" | "solana";
type Status = "idle" | "pending" | "success" | "error";

interface Props {
  billId: string;
  billName: string;
  amount: number;
  icon: string;
  description: string;
  /** Lock to a specific network and hide the selector */
  network?: Network;
}

/** Shows the right number of decimal places for any USDC amount down to $0.000001. */
function fmtUsdc(n: number): string {
  if (n >= 0.01) return n.toFixed(2);
  if (n >= 0.0001) return n.toFixed(4);
  return n.toFixed(6);
}

export function PayBillConfirmCard({ billId, billName, amount, icon, description, network: forcedNetwork }: Props) {
  const { wallets } = useWallets();
  const { markBillPaid, isBillPaid } = useDemoState();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const hasEvmWallet = wallets.some((w) => w.walletClientType === "privy" || (w as any).chainType === "ethereum");
  const hasSolanaWallet = wallets.some((w) => (w as any).chainType === "solana");

  const defaultNetwork: Network = forcedNetwork ?? (hasEvmWallet ? "evm" : "solana");
  const [selectedNetwork, setSelectedNetwork] = useState<Network>(defaultNetwork);

  useEffect(() => { if (forcedNetwork) setSelectedNetwork(forcedNetwork); }, [forcedNetwork]);

  const alreadyPaid = isBillPaid(billId);

  // ── EVM path ───────────────────────────────────────────────────────────────
  const payEvm = useCallback(async (): Promise<{ txHash: string | null }> => {
    const privyWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!privyWallet) throw new Error("No EVM wallet connected");
    const provider = await privyWallet.getEthereumProvider();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = await createViemAdapterFromProvider({ provider: provider as any });
    const result = await arcKit.send({
      from: { adapter, chain: AGENT_CHAIN },
      to: EVM_RECEIVER,
      amount: amount.toFixed(6),
      token: "USDC",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((result as any)?.state && (result as any).state !== "success") throw new Error("Transfer did not complete");
    return { txHash: null };
  }, [wallets, amount]);

  // ── Solana path (Arc AppKit) ───────────────────────────────────────────────
  const paySolana = useCallback(async (): Promise<{ txHash: string | null }> => {
    const solWallet = wallets.find((w) => (w as any).chainType === "solana");
    if (!solWallet) throw new Error("No Solana wallet connected");
    if (!SOL_RECEIVER) throw new Error("Solana receiver not configured");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const solanaProvider = await (solWallet as any).getSolanaProvider?.();
    if (!solanaProvider) throw new Error("Solana provider unavailable");

    const { createSolanaAdapterFromProvider } = await import("@circle-fin/adapter-solana");
    const adapter = await createSolanaAdapterFromProvider({ provider: solanaProvider });

    const result = await arcKit.send({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from: { adapter: adapter as any, chain: SOLANA_ARC_CHAIN },
      to: SOL_RECEIVER,
      amount: amount.toFixed(6),
      token: "USDC",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((result as any)?.state && (result as any).state !== "success") throw new Error("Transfer did not complete");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { txHash: (result as any)?.hash ?? (result as any)?.transactionHash ?? null };
  }, [wallets, amount]);

  // ── Confirm handler ────────────────────────────────────────────────────────
  const handleConfirm = useCallback(async () => {
    if (status === "pending" || status === "success") return;
    setStatus("pending");
    setErrorMsg(null);
    try {
      const { txHash } = selectedNetwork === "solana" ? await paySolana() : await payEvm();

      markBillPaid(billId, amount, billName, { chain: selectedNetwork });

      try {
        await fetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "bill",
            referenceId: billId,
            description: `Paid ${billName}`,
            amountUsdc: amount.toFixed(6),
            status: "completed",
            txHash: txHash ?? null,
            chain: selectedNetwork,
          }),
        });
      } catch { /* non-critical */ }

      setStatus("success");
    } catch (err: unknown) {
      const msg = ((err as Error)?.message ?? "").toLowerCase();
      setErrorMsg(
        msg.includes("reject") || msg.includes("cancel") || msg.includes("denied")
          ? "Payment cancelled."
          : "Payment could not be processed. Please try again.",
      );
      setStatus("error");
    }
  }, [status, selectedNetwork, paySolana, payEvm, billId, billName, amount, markBillPaid]);

  if (alreadyPaid || status === "success") {
    return (
      <div className="my-2 flex items-center gap-3 rounded-xl border border-green-700/30 bg-green-900/10 px-4 py-3">
        <span className="text-xl">{icon}</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-green-400">{billName} — Active ✓</p>
          <p className="text-xs text-[#A7A79A]">
            ${fmtUsdc(amount)}/mo · {selectedNetwork === "solana" ? "Solana" : "Base"} USDC
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-4">
      {/* Header row */}
      <div className="mb-3 flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-[#F2F0E8]">{billName}</p>
          <p className="text-xs text-[#A7A79A]">{description}</p>
        </div>
        <p className="shrink-0 text-sm font-bold text-[#F2F0E8]">
          ${fmtUsdc(amount)}
          <span className="text-xs font-normal text-[#A7A79A]">/mo</span>
        </p>
      </div>

      {/* Network selector — only shown when BOTH wallets are connected and no network is forced.
          When only one wallet is present the defaultNetwork already auto-selects the right one. */}
      {!forcedNetwork && hasEvmWallet && hasSolanaWallet && (
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => setSelectedNetwork("evm")}
            disabled={!hasEvmWallet}
            className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors
              ${selectedNetwork === "evm"
                ? "border-[#8FAE82] bg-[#8FAE82]/10 text-[#8FAE82]"
                : "border-[#2A2B27] text-[#A7A79A] hover:border-[#8FAE82]/40 disabled:opacity-40"}`}
          >
            🔷 Base (EVM)
          </button>
          <button
            onClick={() => setSelectedNetwork("solana")}
            disabled={!hasSolanaWallet}
            className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors
              ${selectedNetwork === "solana"
                ? "border-[#9945FF] bg-[#9945FF]/10 text-[#9945FF]"
                : "border-[#2A2B27] text-[#A7A79A] hover:border-[#9945FF]/40 disabled:opacity-40"}`}
          >
            ◎ Solana
          </button>
        </div>
      )}

      {errorMsg && (
        <p className="mb-3 rounded-lg bg-red-900/20 px-3 py-1.5 text-xs text-red-400">{errorMsg}</p>
      )}

      <button
        onClick={handleConfirm}
        disabled={status === "pending" || (selectedNetwork === "solana" && !hasSolanaWallet)}
        className="w-full rounded-xl bg-[#8FAE82] py-2.5 text-sm font-semibold text-[#141513] disabled:opacity-60"
      >
        {status === "pending"
          ? "Confirming in wallet…"
          : `Confirm · $${fmtUsdc(amount)} USDC · ${selectedNetwork === "solana" ? "Solana" : "Base"}`}
      </button>
    </div>
  );
}
