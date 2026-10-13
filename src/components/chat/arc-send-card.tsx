"use client";

import { useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { authFetch } from "@/lib/api-auth-fetch";
import { payEvmTransfer, pickPrivyWalletOrThrow, waitForEvmTx, friendlyEvmError } from "@/lib/evm-pay";
import { arcChain, ARC_USDC, arcTxUrl } from "@/lib/arc-chain";

/**
 * send_usdc_arc — confirm card. Sends USDC on Arc from the user's Bluvfi
 * wallet (USDC is also Arc's gas) through the shared 3-layer helper, records
 * it in History, and reports {sent, txHash} back to the chat. Nothing moves
 * until the user taps Send.
 */
type Output = {
  arcSend: true;
  recipient: string;
  amount: string;
  note?: string;
  sent?: boolean;
  txHash?: string;
  error?: string;
};

export function ArcSendCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: Output;
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
}) {
  const { wallets } = useWallets();
  const { sendTransaction, getAccessToken } = usePrivy();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">(output.sent === true ? "done" : output.sent === false ? "error" : "idle");
  const [msg, setMsg] = useState<string | null>(output.sent === false ? output.error ?? "Not sent." : null);
  const [txHash, setTxHash] = useState<string | undefined>(output.txHash);
  const short = `${output.recipient.slice(0, 6)}…${output.recipient.slice(-4)}`;

  const report = (result: Record<string, unknown>) =>
    addToolResult({ tool: "send_usdc_arc", toolCallId, output: { ...output, ...result } });

  const send = async () => {
    setMsg(null);
    setState("sending");
    try {
      const { hash } = await payEvmTransfer({
        chainId: arcChain.id,
        token: ARC_USDC,
        symbol: "USDC",
        decimals: 6,
        recipient: output.recipient as `0x${string}`,
        amount: output.amount,
        wallet: pickPrivyWalletOrThrow(wallets),
        sendTransaction,
        label: "chat/arc-send",
      });
      await waitForEvmTx(arcChain.id, hash);
      setTxHash(hash);
      setState("done");
      authFetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "transfer",
          referenceId: hash,
          description: `Sent ${output.amount} USDC on Arc to ${short}`,
          amountUsdc: output.amount,
          status: "completed",
          txHash: hash,
          chain: "arc",
        }),
      }, getAccessToken).catch(() => {});
      report({ sent: true, txHash: hash });
    } catch (err) {
      const friendly = friendlyEvmError(err, "Arc");
      setMsg(friendly);
      setState("error");
      report({ sent: false, error: friendly });
    }
  };

  return (
    <div className="my-2 rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 space-y-3">
      <p className="text-xs font-semibold text-[#F2F0E8]">🟣 Send USDC on Arc</p>
      <div className="rounded-lg bg-[#141513] px-3 py-2 space-y-1">
        <div className="flex justify-between text-xs"><span className="text-[#A7A79A]">Amount</span><span className="font-mono font-bold text-[#F2F0E8]">{output.amount} USDC</span></div>
        <div className="flex justify-between text-xs"><span className="text-[#A7A79A]">To</span><span className="font-mono text-[#F2F0E8]">{short}</span></div>
        {output.note && <p className="text-[10px] text-[#A7A79A]">{output.note}</p>}
      </div>
      <p className="text-[10px] text-[#A7A79A]">USDC also pays Arc&apos;s network fee — nothing else is needed.</p>
      {msg && <p className="text-xs text-red-400">{msg}</p>}
      {state === "done" ? (
        <p className="text-xs text-green-400">
          ✓ Sent.{" "}
          {txHash && <a href={arcTxUrl(txHash)} target="_blank" rel="noopener noreferrer" className="text-[#8FAE82] underline">View transaction</a>}
        </p>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => { setState("error"); report({ sent: false, error: "Cancelled by user" }); }}
            disabled={state === "sending"}
            className="flex-1 rounded-xl border border-[#2A2B27] py-2.5 text-xs font-medium text-[#A7A79A]"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={state === "sending"}
            className="flex-1 rounded-xl bg-[#8FAE82] py-2.5 text-xs font-semibold text-[#141513] disabled:opacity-50"
          >
            {state === "sending" ? "Sending…" : state === "error" ? "Try again" : `Send ${output.amount} USDC`}
          </button>
        </div>
      )}
    </div>
  );
}
