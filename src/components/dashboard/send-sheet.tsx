"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { parseUnits, parseEther, encodeFunctionData, erc20Abi } from "viem";
import type { Address, Hex } from "viem";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { payEvmTransfer, pickPrivyWalletOrThrow, friendlyEvmError } from "@/lib/evm-pay";
import { arcChain, ARC_USDC, arcTxUrl } from "@/lib/arc-chain";
import { useArcUsdcBalance } from "@/hooks/use-arc-balance";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useChatSheet } from "@/contexts/chat-context";

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

type Step = "idle" | "processing" | "success" | "error";
/** "ARC_USDC" = USDC on Arc mainnet, where USDC is also the gas token. */
type Token = "ETH" | "USDC" | "ARC_USDC";
const TOKEN_LABEL: Record<Token, string> = { ETH: "ETH", USDC: "USDC", ARC_USDC: "USDC · Arc" };

interface SendSheetProps {
  walletBalanceUsd: number;
  walletAssets: { symbol: string; balance: string }[];
  onClose: () => void;
  onSuccess: () => void;
}

export function SendSheet({ walletAssets, onClose, onSuccess }: SendSheetProps) {
  const { user, sendTransaction } = usePrivy();
  const { wallets } = useWallets();
  const { arcUsdc, refresh: refreshArc } = useArcUsdcBalance();
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const { client } = useSmartWallets();
  const walletAddress = (user?.smartWallet?.address ?? user?.wallet?.address) as Address | undefined;

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<Token>("USDC");
  const [step, setStep] = useState<Step>("idle");
  const [hash, setHash] = useState<Hex | undefined>();

  const ethBalance = walletAssets.find((a) => a.symbol === "ETH")?.balance ?? "0";
  const usdcBalance = walletAssets.find((a) => a.symbol === "USDC")?.balance ?? "0";
  const selectedBalance = token === "ETH" ? ethBalance : token === "ARC_USDC" ? String(arcUsdc ?? 0) : usdcBalance;

  const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(recipient);
  const amountNum = parseFloat(amount) || 0;
  const exceedsBalance = amountNum > parseFloat(selectedBalance);
  // Arc sends go from the Privy wallet through the shared payment helper, so they don't need the smart-wallet client.
  const canSend = isValidAddress && amountNum > 0 && !exceedsBalance && step === "idle" && (token === "ARC_USDC" || !!client);

  const handleSend = useCallback(async () => {
    if (!canSend || (token !== "ARC_USDC" && (!client || !walletAddress))) return;
    setStep("processing");
    setErrMsg(null);
    try {
      let txHash: Hex;
      if (token === "ARC_USDC") {
        // Arc mainnet: USDC pays for the transfer and the gas (shared 3-layer fallback).
        ({ hash: txHash } = await payEvmTransfer({
          chainId: arcChain.id,
          token: ARC_USDC,
          symbol: "USDC",
          decimals: 6,
          recipient: recipient as Address,
          amount,
          wallet: pickPrivyWalletOrThrow(wallets),
          sendTransaction,
          label: "send-arc",
        }));
        void refreshArc();
      } else if (token === "ETH") {
        if (!client) throw new Error("Wallet not ready.");
        txHash = await client.sendTransaction({
          calls: [{
            to: recipient as Address,
            value: parseEther(amount),
          }],
        });
      } else {
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient as Address, parseUnits(amount, 6)],
        });
        if (!client) throw new Error("Wallet not ready.");
        txHash = await client.sendTransaction({
          calls: [{
            to: USDC_BASE,
            data,
          }],
        });
      }
      setHash(txHash);
      setStep("success");
      onSuccess();
    } catch (err) {
      setErrMsg(friendlyEvmError(err, token === "ARC_USDC" ? "Arc" : "Base"));
      setStep("error");
    }
  }, [canSend, client, walletAddress, token, recipient, amount, onSuccess, wallets, sendTransaction, refreshArc]);

  // Sync to chat bar
  const { setActiveSheet } = useChatSheet();
  const handleSendRef = useRef(handleSend);
  const onCloseRef = useRef(onClose);
  handleSendRef.current = handleSend;
  onCloseRef.current = onClose;

  useEffect(() => {
    setActiveSheet({
      type: "deposit",
      onConfirm: () => (step === "error" ? setStep("idle") : handleSendRef.current()),
      onCancel: () => onCloseRef.current(),
      step,
    });
  }, [step, setActiveSheet]);

  useEffect(() => {
    return () => setActiveSheet(null);
  }, [setActiveSheet]);

  return createPortal(
    <>
      <motion.div
        key="send-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-ink/10"
        onClick={step === "idle" || step === "success" ? onClose : undefined}
      />
      <motion.div
        key="send-sheet"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        drag={step === "idle" || step === "success" ? "y" : false}
        dragConstraints={{ top: 0 }}
        dragElastic={0.2}
        onDragEnd={(_, info) => {
          if (info.offset.y > 100 || info.velocity.y > 500) onClose();
        }}
        className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-lg rounded-t-2xl border-t border-border bg-cream px-6 pb-[calc(max(env(safe-area-inset-bottom),24px)+72px)] pt-4"
      >
        {/* Drag handle */}
        <div className="mx-auto mb-6 h-1 w-10 rounded-full bg-border" />

        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="font-display text-xl text-ink">Send</span>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 transition-colors duration-200 hover:bg-ink/[0.04]"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-ink-light">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {step === "success" ? (
          <div className="mt-8 flex flex-col items-center gap-3 py-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-sage/10">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-sage">
                <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="font-display text-2xl text-ink">Sent!</p>
            {hash && (
              <a
                href={token === "ARC_USDC" ? arcTxUrl(hash) : `https://basescan.org/tx/${hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[10px] text-sage underline"
              >
                View transaction
              </a>
            )}
          </div>
        ) : (
          <>
            {/* Token selector */}
            <div className="mt-6 flex gap-2">
              {(["ETH", "USDC", "ARC_USDC"] as Token[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setToken(t)}
                  className={`rounded-full px-4 py-1.5 font-mono text-xs transition-colors duration-200 ${
                    token === t
                      ? "bg-ink text-cream"
                      : "bg-cream-dark text-ink-light"
                  }`}
                >
                  {TOKEN_LABEL[t]}
                </button>
              ))}
            </div>
            {token === "ARC_USDC" && (
              <p className="mt-2 font-mono text-[10px] text-ink-light">On Arc, USDC is also the gas token — you only need USDC.</p>
            )}

            {/* Amount */}
            <div className="mt-5">
              <label className="label-mono text-[10px]">Amount</label>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value))
                    setAmount(e.target.value);
                }}
                disabled={step === "processing"}
                className="mt-1 w-full border-b border-border bg-transparent pb-2 font-display text-3xl text-ink outline-none placeholder:text-ink/20"
              />
              <div className="mt-1.5 flex items-center justify-between">
                <span className="font-mono text-[10px] text-ink-light">
                  Balance: {parseFloat(selectedBalance).toLocaleString("en-US", { maximumFractionDigits: 6 })} {TOKEN_LABEL[token]}
                </span>
                <button
                  onClick={() => setAmount(selectedBalance)}
                  className="font-mono text-[10px] text-sage"
                >
                  Max
                </button>
              </div>
              {exceedsBalance && (
                <p className="mt-1 font-mono text-[10px] text-fail">Exceeds available balance</p>
              )}
            </div>

            {/* Recipient */}
            <div className="mt-5">
              <label className="label-mono text-[10px]">Recipient</label>
              <input
                type="text"
                placeholder="0x..."
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                disabled={step === "processing"}
                className="mt-1 w-full border-b border-border bg-transparent pb-2 font-mono text-sm text-ink outline-none placeholder:text-ink/20"
              />
              {recipient.length > 0 && !isValidAddress && (
                <p className="mt-1 font-mono text-[10px] text-fail">Invalid address</p>
              )}
            </div>

            {step === "error" && (
              <p className="mt-4 text-center font-mono text-xs text-fail">
                {errMsg ?? "Transaction failed. Try again."}
              </p>
            )}
          </>
        )}
        {/* iOS Safari bottom gap extension */}
        <div className="absolute -bottom-48 inset-x-0 h-48 bg-cream" />
      </motion.div>
    </>,
    document.body,
  );
}
