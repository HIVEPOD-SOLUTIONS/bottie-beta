"use client";

import { useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, http, erc20Abi, encodeFunctionData, parseAbi, type Hex } from "viem";
import { payEvm, waitForEvmTx, friendlyEvmError } from "@/lib/evm-pay";
import { domaChain, DOMA_BRIDGE_URL } from "@/lib/doma-chain";

/**
 * Pay card for the AI's doma_create_order tool. Doma returns a signed payment
 * voucher; paying it is on-chain on the Doma chain from the user's own wallet:
 * approve the token (USDC.e) to Doma's payment contract, then pay(voucher,
 * signature) — or a single pay with value for native ETH. Nothing is sent
 * until the user taps Pay. Reports {paid, txHash} back to the chat.
 */

type Step = { step: number; action: "approve" | "pay"; contract: string; args: Record<string, unknown>; value?: string };

type Output = {
  domaPayment: true;
  order: { orderId: string; totalPayment: string; items?: { name?: string; domain?: string }[]; voucherExpiresAt?: string };
  payment: { payTo: string | null; token: string; amount: string; steps: Step[] };
  paid?: boolean;
  txHash?: string;
  error?: string;
};

type State = "idle" | "checking" | "approving" | "paying" | "done" | "error";

const PAY_ABI = parseAbi([
  "function pay((address buyer, address token, uint256 amount, uint256 voucherExpiration, string paymentId, string orderId) voucher, bytes signature) payable",
]);

export function DomaPaymentCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: Output;
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
}) {
  const { wallets } = useWallets();
  const { sendTransaction } = usePrivy();
  const [state, setState] = useState<State>(output.paid === true ? "done" : output.paid === false ? "error" : "idle");
  const [msg, setMsg] = useState<string | null>(output.paid === false ? output.error ?? "Payment didn't go through." : null);
  const [txHash, setTxHash] = useState<string | undefined>(output.txHash);

  const native = output.payment.token === "native";
  const decimals = native ? 18 : 6; // USDC.e has 6 decimals
  const amountAtomic = BigInt(output.payment.amount);
  const display = `${(Number(amountAtomic) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: native ? 6 : 2 })} ${native ? "ETH" : "USDC.e"}`;
  const domains = (output.order.items ?? []).map((i) => i.name ?? i.domain).filter(Boolean).join(", ");
  const expired = output.order.voucherExpiresAt ? new Date(output.order.voucherExpiresAt).getTime() < Date.now() : false;

  const report = (result: Record<string, unknown>) =>
    addToolResult({ tool: "doma_create_order", toolCallId, output: { ...output, ...result } });

  const pay = async () => {
    setMsg(null);
    try {
      const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
      if (!wallet) throw new Error("No wallet connected.");
      const from = wallet.address as Hex;
      const payStep = output.payment.steps.find((s) => s.action === "pay");
      if (!payStep || !output.payment.payTo) throw new Error("Doma didn't return a payment contract. Ask the assistant to create the order again.");

      // Pre-flight on the Doma chain: the token balance, and a little ETH for gas.
      setState("checking");
      const pub = createPublicClient({ chain: domaChain, transport: http() });
      const gas = await pub.getBalance({ address: from });
      const tokenBal = native ? gas : await pub.readContract({ address: output.payment.token as Hex, abi: erc20Abi, functionName: "balanceOf", args: [from] });
      if (tokenBal < amountAtomic) throw new Error(`You need ${display} on the Doma chain. Bridge funds at ${DOMA_BRIDGE_URL}, then try again.`);
      // No gas check here: Layer 1 (sponsored) doesn't need ETH; Layer 2 checks it itself.

      // Both steps go through the shared fallback (sponsored → user gas); see lib/evm-pay.ts.
      if (!native) {
        // Skip the approve if an earlier attempt already granted enough.
        const allowance = await pub.readContract({ address: output.payment.token as Hex, abi: erc20Abi, functionName: "allowance", args: [from, output.payment.payTo as Hex] });
        if (allowance < amountAtomic) {
          setState("approving");
          const { hash: approveHash } = await payEvm({
            payment: {
              chainId: domaChain.id,
              to: output.payment.token as Hex,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [output.payment.payTo as Hex, amountAtomic] }),
            },
            wallet, sendTransaction, label: "doma",
          });
          await waitForEvmTx(domaChain.id, approveHash);
        }
      }

      setState("paying");
      const v = payStep.args.voucher as Record<string, string | number>;
      const voucher = {
        buyer: v.buyer as Hex,
        token: v.token as Hex,
        amount: BigInt(v.amount),
        voucherExpiration: BigInt(v.voucherExpiration),
        paymentId: String(v.paymentId),
        orderId: String(v.orderId),
      };
      const { hash } = await payEvm({
        payment: {
          chainId: domaChain.id,
          to: output.payment.payTo as Hex,
          data: encodeFunctionData({ abi: PAY_ABI, functionName: "pay", args: [voucher, payStep.args.signature as Hex] }),
          ...(native ? { value: amountAtomic } : {}),
        },
        wallet, sendTransaction, label: "doma",
      });
      await waitForEvmTx(domaChain.id, hash);
      setTxHash(hash);
      setState("done");
      report({ paid: true, txHash: hash });
    } catch (e) {
      let m = friendlyEvmError(e, "the Doma chain");
      if (/gas/i.test(m)) m += ` Bridge a little ETH at ${DOMA_BRIDGE_URL}, then try again.`;
      setState("error");
      setMsg(m);
      report({ paid: false, error: m });
    }
  };

  const busy = state === "checking" || state === "approving" || state === "paying";

  return (
    <div className="my-2 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-lg">🌐</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#F2F0E8]">{domains || "Doma domain order"}</p>
          <p className="text-xs text-[#A7A79A]">Doma · order {output.order.orderId.slice(0, 8)}…</p>
        </div>
        <p className="shrink-0 text-sm font-bold text-[#F2F0E8]">{display}</p>
      </div>

      {state === "idle" && (
        expired ? (
          <p className="mt-3 text-xs text-amber-400/90">This payment voucher has expired. Ask the assistant to create the order again.</p>
        ) : (
          <>
            <p className="mt-3 text-[11px] text-[#A7A79A]">
              Paid on the Doma chain from your wallet{native ? "" : " (approve, then pay)"}. Needs {display} and a little ETH for gas there.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => { setState("error"); setMsg("Cancelled. Nothing was sent."); report({ paid: false, error: "Cancelled by user" }); }}
                className="flex-1 rounded-xl bg-white/[0.06] py-2.5 text-xs font-semibold text-[#F2F0E8]"
              >Cancel</button>
              <button onClick={pay} className="flex-1 rounded-xl bg-[#8FAE82] py-2.5 text-xs font-semibold text-[#141513]">Pay {display}</button>
            </div>
          </>
        )
      )}

      {busy && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[#A7A79A]">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
          {state === "checking" ? "Checking your Doma balance…" : state === "approving" ? "Approve USDC.e in your wallet (1 of 2)…" : `Confirm the payment in your wallet${native ? "" : " (2 of 2)"}…`}
        </div>
      )}

      {state === "done" && (
        <p className="mt-3 text-xs text-[#F2F0E8]">
          ✅ Paid.{" "}
          {txHash && (
            <a href={`${domaChain.blockExplorers.default.url}/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="text-[#8FAE82] underline">View transaction</a>
          )}{" "}
          Registration completes shortly.
        </p>
      )}

      {state === "error" && msg && <p className="mt-3 text-xs text-red-400">{msg}</p>}
    </div>
  );
}
