"use client";

import { useState, useCallback, useEffect } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { arcKit, AGENT_CHAIN } from "@/lib/arc-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { authFetch } from "@/lib/api-auth-fetch";

const EVM_RECEIVER = "0x9404966338eB27aF420a952574d777598Bbb58c4" as const;
const SOL_RECEIVER = process.env.NEXT_PUBLIC_SOLANA_BILL_RECEIVER ?? "";

type Network = "evm" | "solana";

type Status = "idle" | "pending" | "success" | "error";

interface Props {
  symbol: string;
  assetName: string;
  shares: number;
  priceUsd: number;
  totalUsdc: number;
  icon: string;
  type: string;
  /** Lock to a specific network and hide the selector */
  network?: Network;
}

/** Shows the right number of decimal places for any USDC amount down to $0.000001. */
function fmtUsdc(n: number): string {
  if (n >= 0.01) return n.toFixed(2);
  if (n >= 0.0001) return n.toFixed(4);
  return n.toFixed(6);
}

export function BuyAssetConfirmCard({
  symbol,
  assetName,
  shares,
  priceUsd,
  totalUsdc,
  icon,
  type,
  network: forcedNetwork,
}: Props) {
  const { getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const hasEvmWallet = wallets.some((w) => w.walletClientType === "privy" || (w as any).chainType === "ethereum");
  const hasSolanaWallet = solanaWallets.length > 0;

  const defaultNetwork: Network = forcedNetwork ?? (hasEvmWallet ? "evm" : "solana");
  const [selectedNetwork, setSelectedNetwork] = useState<Network>(defaultNetwork);

  useEffect(() => { if (forcedNetwork) setSelectedNetwork(forcedNetwork); }, [forcedNetwork]);

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
      amount: totalUsdc.toFixed(6),
      token: "USDC",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((result as any)?.state && (result as any).state !== "success") throw new Error("Transfer did not complete");
    return { txHash: null };
  }, [wallets, totalUsdc]);

  // ── Solana path (direct SPL transfer) ─────────────────────────────────────
  const paySolana = useCallback(async (): Promise<{ txHash: string | null }> => {
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
    const requiredMicro = BigInt(Math.round(totalUsdc * 1_000_000));
    if (!senderAccount || senderAccount.amount < requiredMicro) {
      const bal = senderAccount ? (Number(senderAccount.amount) / 1_000_000).toFixed(2) : "0.00";
      throw new Error(
        `Insufficient USDC balance on Solana. You have $${bal} but need $${totalUsdc.toFixed(2)}.`
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
    const txHash = await connection.sendRawTransaction(Transaction.from(signedTransaction).serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction({ signature: txHash, blockhash, lastValidBlockHeight }, "confirmed");
    return { txHash };
  }, [solanaWallets, totalUsdc]);

  const handleConfirm = useCallback(async () => {
    if (status === "pending" || status === "success") return;
    setStatus("pending");
    setErrorMsg(null);

    try {
      const { txHash } = selectedNetwork === "solana" ? await paySolana() : await payEvm();

      // Persist to investments table (position) + payments ledger (transaction)
      // Both are fire-and-forget so they never block the success UI
      authFetch("/api/investments/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          shares,
          pricePerShare: priceUsd,
        }),
      }, getAccessToken).catch(() => {});

      authFetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "investment",
          referenceId: symbol,
          description: `Bought ${shares} share${shares !== 1 ? "s" : ""} of ${assetName} (${symbol})`,
          amountUsdc: totalUsdc.toFixed(6),
          status: "completed",
          txHash: txHash ?? null,
          chain: selectedNetwork,
        }),
      }, getAccessToken).catch(() => {});

      setStatus("success");
    } catch (err: unknown) {
      const msg = ((err as Error)?.message ?? "").toLowerCase();
      setErrorMsg(
        msg.includes("reject") || msg.includes("cancel") || msg.includes("denied")
          ? "Purchase cancelled."
          : "Purchase could not be processed. Please try again.",
      );
      setStatus("error");
    }
  }, [status, selectedNetwork, paySolana, payEvm, symbol, assetName, shares, priceUsd, totalUsdc, getAccessToken]);

  if (status === "success") {
    return (
      <div className="my-2 flex items-center gap-3 rounded-xl border border-green-700/30 bg-green-900/10 px-4 py-3">
        <span className="text-xl">{icon}</span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-green-400">
            {shares} share{shares !== 1 ? "s" : ""} of {symbol} — Purchased ✓
          </p>
          <p className="text-xs text-[#A7A79A]">
            ${fmtUsdc(totalUsdc)} USDC · {selectedNetwork === "solana" ? "Solana" : "Base"}
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
          <p className="text-sm font-semibold text-[#F2F0E8]">
            {assetName}
            <span className="ml-1.5 text-xs font-normal text-[#A7A79A]">{symbol}</span>
          </p>
          <p className="text-xs text-[#A7A79A]">
            {shares} share{shares !== 1 ? "s" : ""} @ ${priceUsd.toFixed(2)}
          </p>
        </div>
        <p className="shrink-0 text-sm font-bold text-[#F2F0E8]">
          ${fmtUsdc(totalUsdc)}
          <span className="block text-right text-[10px] font-normal text-[#A7A79A]">USDC</span>
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
          : `Confirm · $${fmtUsdc(totalUsdc)} USDC · ${selectedNetwork === "solana" ? "Solana" : "Base"}`}
      </button>
    </div>
  );
}
