"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useWallets } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { arcKit, AGENT_CHAIN } from "@/lib/arc-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";

const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const; // Base mainnet USDC
const EVM_RECEIVER = "0x9404966338eB27aF420a952574d777598Bbb58c4" as const;
const SOL_RECEIVER = process.env.NEXT_PUBLIC_SOLANA_BILL_RECEIVER ?? "";

type Network = "evm" | "solana";

/** Shows the right number of decimal places for any USDC amount down to $0.000001. */
function fmtUsdc(n: number): string {
  if (n >= 0.01) return n.toFixed(2);
  if (n >= 0.0001) return n.toFixed(4);
  return n.toFixed(6);
}

const TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function" as const,
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

interface PaymentModalProps {
  title: string;
  subtitle: string;
  icon: string;
  amount: number;
  ctaLabel?: string;
  /** Lock to a specific network; omit to show the selector */
  network?: Network;
  onSuccess: (txHash: string, chain: Network) => void;
  onClose: () => void;
}

export function PaymentModal({
  title,
  subtitle,
  icon,
  amount,
  ctaLabel,
  network: forcedNetwork,
  onSuccess,
  onClose,
}: PaymentModalProps) {
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const [arcPending, setArcPending] = useState(false);
  const [arcError, setArcError] = useState<string | null>(null);

  const hasEvmWallet = wallets.some((w) => w.walletClientType === "privy" || (w as any).chainType === "ethereum");
  const hasSolanaWallet = solanaWallets.length > 0;
  const defaultNetwork: Network = forcedNetwork ?? (hasEvmWallet ? "evm" : "solana");
  const [selectedNetwork, setSelectedNetwork] = useState<Network>(defaultNetwork);

  useEffect(() => { if (forcedNetwork) setSelectedNetwork(forcedNetwork); }, [forcedNetwork]);

  // wagmi fallback — only used for non-Privy EVM wallets
  const {
    writeContract,
    data: txHash,
    isPending,
    error: wagmiError,
    reset,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isConfirmed && txHash) {
      onSuccess(txHash, "evm");
    }
  }, [isConfirmed, txHash, onSuccess]);

  // ── EVM payment ────────────────────────────────────────────────────────────
  const payEvm = useCallback(async () => {
    const privyWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (privyWallet) {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hash = (result as any)?.hash ?? (result as any)?.transactionHash ?? `arc-${Date.now()}`;
      onSuccess(hash, "evm");
      return;
    }
    // wagmi fallback for external wallets
    reset();
    writeContract({
      address: USDC_CONTRACT,
      abi: TRANSFER_ABI,
      functionName: "transfer",
      args: [EVM_RECEIVER, parseUnits(amount.toFixed(6), 6)],
    });
  }, [wallets, amount, onSuccess, reset, writeContract]);

  // ── Solana payment (direct SPL transfer) ─────────────────────────────────
  const paySolana = useCallback(async () => {
    const solWallet = solanaWallets[0];
    if (!solWallet) throw new Error("No Solana wallet connected");
    if (!SOL_RECEIVER) throw new Error("Solana receiver not configured");

    const { PublicKey, Transaction, Connection } = await import("@solana/web3.js");
    const { getAssociatedTokenAddress, createTransferInstruction, getAccount, TOKEN_PROGRAM_ID } =
      await import("@solana/spl-token");

    const solRpc = `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
    const connection = new Connection(solRpc, "confirmed");

    const USDC_MINT      = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const senderPubkey   = new PublicKey(solWallet.address);
    const receiverPubkey = new PublicKey(SOL_RECEIVER);

    // Pre-flight balance check
    const senderAta     = await getAssociatedTokenAddress(USDC_MINT, senderPubkey);
    const senderAccount = await getAccount(connection, senderAta).catch(() => null);
    const requiredMicro = BigInt(Math.round(amount * 1_000_000));
    if (!senderAccount || senderAccount.amount < requiredMicro) {
      const bal = senderAccount ? (Number(senderAccount.amount) / 1_000_000).toFixed(2) : "0.00";
      throw new Error(
        `Insufficient USDC balance on Solana. You have $${bal} but need $${amount.toFixed(2)}.`
      );
    }

    // Build, sign, and send
    const receiverAta = await getAssociatedTokenAddress(USDC_MINT, receiverPubkey);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: senderPubkey }).add(
      createTransferInstruction(senderAta, receiverAta, senderPubkey, requiredMicro, [], TOKEN_PROGRAM_ID),
    );
    const txBytes = Buffer.from(tx.serialize({ requireAllSignatures: false }));
    const { signedTransaction } = await solWallet.signTransaction({ transaction: txBytes });
    const hash = await connection.sendRawTransaction(Transaction.from(signedTransaction).serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction({ signature: hash, blockhash, lastValidBlockHeight }, "confirmed");
    onSuccess(hash, "solana");
  }, [solanaWallets, amount, onSuccess]);

  const handlePay = useCallback(async () => {
    if (arcPending || isPending || isConfirming) return;
    setArcError(null);
    setArcPending(true);
    try {
      if (selectedNetwork === "solana") {
        await paySolana();
      } else {
        await payEvm();
      }
    } catch (err: any) {
      console.error("[PaymentModal] payment failed:", err);
      const msg = (err?.message ?? "").toLowerCase();
      setArcError(
        msg.includes("reject") || msg.includes("cancel") || msg.includes("denied")
          ? "Payment cancelled."
          : "Payment could not be processed. Please try again.",
      );
    } finally {
      setArcPending(false);
    }
  }, [arcPending, isPending, isConfirming, selectedNetwork, paySolana, payEvm]);

  const isBusy = arcPending || isPending || isConfirming;

  let btnLabel = ctaLabel ?? `Pay $${fmtUsdc(amount)}`;
  if (arcPending || isPending) btnLabel = "Confirm in wallet…";
  if (isConfirming) btnLabel = "Processing payment…";

  const friendlyError =
    arcError ??
    (wagmiError
      ? wagmiError.message?.includes("User rejected")
        ? "Payment cancelled."
        : "Payment could not be processed. Please try again."
      : null);

  const modal = (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-t-3xl bg-[#1B1C19] p-6 pb-10 border-t border-[#2A2B27]">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-[#F2F0E8]">Confirm Payment</h3>
          <button
            onClick={onClose}
            disabled={isBusy}
            className="rounded-full p-1.5 text-[#A7A79A] hover:bg-white/[0.06] disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {/* Details card */}
        <div className="mb-4 rounded-2xl bg-[#141513] border border-[#2A2B27] p-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-3xl">
              {icon}
            </div>
            <div>
              <p className="font-semibold text-[#F2F0E8]">{title}</p>
              <p className="text-sm text-[#A7A79A]">{subtitle}</p>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-[#2A2B27] pt-3">
            <span className="text-sm text-[#A7A79A]">Amount due</span>
            <span className="text-2xl font-bold text-[#F2F0E8]">
              ${fmtUsdc(amount)}
            </span>
          </div>
        </div>

        {/* Network selector — only shown when BOTH wallets are connected and no network is forced.
            When only one wallet is present the defaultNetwork already auto-selects the right one. */}
        {!forcedNetwork && hasEvmWallet && hasSolanaWallet && (
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setSelectedNetwork("evm")}
              disabled={!hasEvmWallet || isBusy}
              className={`flex-1 rounded-xl border py-2 text-xs font-medium transition-colors
                ${selectedNetwork === "evm"
                  ? "border-[#8FAE82] bg-[#8FAE82]/10 text-[#8FAE82]"
                  : "border-[#2A2B27] text-[#A7A79A] hover:border-[#8FAE82]/40 disabled:opacity-40"}`}
            >
              🔷 Base (EVM)
            </button>
            <button
              onClick={() => setSelectedNetwork("solana")}
              disabled={!hasSolanaWallet || isBusy}
              className={`flex-1 rounded-xl border py-2 text-xs font-medium transition-colors
                ${selectedNetwork === "solana"
                  ? "border-[#9945FF] bg-[#9945FF]/10 text-[#9945FF]"
                  : "border-[#2A2B27] text-[#A7A79A] hover:border-[#9945FF]/40 disabled:opacity-40"}`}
            >
              ◎ Solana
            </button>
          </div>
        )}

        {/* Error */}
        {friendlyError && (
          <div className="mb-4 rounded-xl bg-red-900/20 px-4 py-2.5 text-sm text-red-400">
            {friendlyError}
          </div>
        )}

        {/* CTA */}
        <button
          onClick={handlePay}
          disabled={isBusy || (selectedNetwork === "solana" && !hasSolanaWallet)}
          className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-60"
        >
          {isBusy ? btnLabel : `${ctaLabel ?? `Pay $${fmtUsdc(amount)}`} · ${selectedNetwork === "solana" ? "Solana" : "Base"}`}
        </button>
        <button
          onClick={onClose}
          disabled={isBusy}
          className="mt-3 w-full rounded-2xl py-2.5 text-sm text-[#A7A79A] disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
