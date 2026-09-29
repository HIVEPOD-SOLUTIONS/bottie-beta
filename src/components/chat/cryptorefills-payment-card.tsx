"use client";

import { useEffect, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { authFetch } from "@/lib/api-auth-fetch";
import { usePaymentsContext } from "@/contexts/payments-context";
import {
  payCryptorefillsOrder,
  pollCryptorefillsOrder,
  pickEvmWallet,
  friendlyPayError,
  validatePartnerOrder,
  createPartnerOrder,
  pollPartnerOrder,
  RAIL_LABEL,
  type CrPayStep,
} from "@/lib/cryptorefills-client";
import { Delivered, DepositPanel, usd } from "@/components/dashboard/cryptorefills-section";
import type { CrOrderRequest, CrOrderStatus, CrPartnerOrder, CrPartnerRequest, CrPartnerStatus, CrRail } from "@/lib/cryptorefills";

/**
 * Payment card for the AI's buy_cryptorefills_product tool — the same three
 * ways to pay as Bills → Cryptorefills. Nothing is created upstream until the
 * user taps Confirm.
 *
 *   payWith base/solana: runs the gasless x402 checkout, shows the code.
 *   payWith other:       creates a deposit-address order and shows where to send.
 *
 * It reports {paid, orderId, …} back to the chat. Once reported, the output
 * carries `paid`, so a re-render shows the order instead of offering to pay again.
 */

type Output = {
  pendingCryptorefillsPayment: true;
  productName: string;
  priceUsd: number;
  recipient: string;
  kind?: string;
  logoUrl?: string;
  logoBg?: string;
  payWith?: CrRail | "other";
  rail?: CrRail;
  order?: CrOrderRequest;
  partnerOrder?: CrPartnerRequest;
  // Set after the card reports back:
  paid?: boolean;
  orderId?: string;
  deposit?: CrPartnerOrder;
  error?: string;
};

type State = "idle" | CrPayStep | "confirmPrice" | "polling" | "deposit" | "done" | "error";

export function CryptorefillsPaymentCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: Output;
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
}) {
  const { getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { refetch: refetchPayments } = usePaymentsContext();
  const payWith = output.payWith ?? output.rail ?? "base";
  const isOther = payWith === "other";
  const email = output.order?.email ?? output.partnerOrder?.email ?? "";

  const [state, setState] = useState<State>(
    output.paid ? (isOther && output.deposit ? "deposit" : "polling") : output.paid === false ? "error" : "idle",
  );
  const [msg, setMsg] = useState<string | null>(output.paid === false ? output.error ?? "Payment didn't complete." : null);
  const [order, setOrder] = useState<CrOrderStatus | null>(null);
  const [deposit, setDeposit] = useState<CrPartnerOrder | null>(output.deposit ?? null);
  const [depositState, setDepositState] = useState("awaiting_payment");
  const [priceConfirm, setPriceConfirm] = useState<{ amount: number; resolve: (ok: boolean) => void } | null>(null);
  const abort = useRef(new AbortController());

  useEffect(() => () => abort.current.abort(), []);

  const report = (result: Record<string, unknown>) =>
    addToolResult({ tool: "buy_cryptorefills_product", toolCallId, output: { ...output, ...result } });

  const finish = (o: CrOrderStatus) => {
    setOrder(o);
    refetchPayments?.();
    if (o.status === "completed") setState("done");
    else {
      setState("error");
      setMsg(o.status === "processing"
        ? `Still processing. The code will arrive by email (order ${o.order_id}).`
        : `The order ${o.status}. Cryptorefills refunds automatically; contact support@cryptorefills.com with order ${o.order_id}.`);
    }
  };

  const finishDeposit = (o: CrPartnerStatus | null) => {
    if (!o) return;
    refetchPayments?.();
    if (o.status === "completed") {
      finish({ order_id: o.order_id, status: "completed", deliveries: o.deliveries });
    } else if (o.status === "failed" || o.status === "expired") {
      setState("error");
      setMsg(o.status === "expired"
        ? "The payment window closed. If you already sent funds, email support@cryptorefills.com with your transaction hash."
        : `The order didn't complete. Contact support@cryptorefills.com with order ${o.order_id}.`);
    }
  };

  const watchDeposit = (orderId: string) =>
    pollPartnerOrder(orderId, getAccessToken, { onUpdate: (o) => setDepositState(o.status), signal: abort.current.signal })
      .then((o) => { if (!abort.current.signal.aborted) finishDeposit(o); });

  // Already reported in an earlier render: resume the order instead of offering to pay again.
  useEffect(() => {
    if (!output.paid || !output.orderId) return;
    if (isOther) {
      authFetch(`/api/cryptorefills/partner-orders/${encodeURIComponent(output.orderId)}`, undefined, getAccessToken)
        .then((r) => r.json())
        .then((d) => {
          if (!d.order) return;
          setDepositState(d.order.status);
          if (["completed", "failed", "expired"].includes(d.order.status)) finishDeposit(d.order);
          else void watchDeposit(output.orderId!);
        })
        .catch(() => {});
      return;
    }
    authFetch(`/api/cryptorefills/orders/${encodeURIComponent(output.orderId)}`, undefined, getAccessToken)
      .then((r) => r.json())
      .then((d) => { if (d.order) finish(d.order); else { setState("error"); setMsg(d.error ?? "Couldn't load the order."); } })
      .catch(() => { setState("error"); setMsg("Couldn't load the order. The code was emailed to you."); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output.paid, output.orderId]);

  const confirmOther = async () => {
    if (!output.partnerOrder) throw new Error("Missing order details. Ask the assistant again.");
    setState("quoting");
    await validatePartnerOrder(output.partnerOrder, getAccessToken);
    const created = await createPartnerOrder(output.partnerOrder, output.priceUsd, output.productName, getAccessToken);
    setDeposit(created);
    setState("deposit");
    refetchPayments?.();
    // Include the deposit details so a re-render can show them again.
    report({ paid: true, orderId: created.order_id, status: "awaiting_payment", deposit: created });
    await watchDeposit(created.order_id);
  };

  const confirmGasless = async (rail: CrRail) => {
    if (!output.order) throw new Error("Missing order details. Ask the assistant again.");
    const receipt = await payCryptorefillsOrder({
      order: output.order,
      productName: output.productName,
      expectedUsd: output.priceUsd,
      rail,
      evmWallet: pickEvmWallet(wallets),
      solanaWallet: solanaWallets[0],
      getAccessToken,
      onStep: setState,
      confirmPriceChange: (amount) => new Promise<boolean>((resolve) => {
        setPriceConfirm({ amount, resolve: (ok) => { setPriceConfirm(null); resolve(ok); } });
        setState("confirmPrice");
      }),
    });
    if (!receipt) {
      setState("error");
      setMsg("You declined the new price. Nothing was charged.");
      report({ paid: false, error: "User declined a price change. Nothing was charged." });
      return;
    }
    // Report as soon as money has moved, before waiting on delivery.
    report({ paid: true, orderId: receipt.order_id, status: receipt.status });
    if (receipt.status !== "processing") { finish(receipt); return; }
    setState("polling");
    setOrder(receipt);
    const final = await pollCryptorefillsOrder(receipt.order_id, getAccessToken, { onUpdate: setOrder, signal: abort.current.signal });
    if (!abort.current.signal.aborted) finish(final ?? receipt);
  };

  const confirm = async () => {
    setMsg(null);
    try {
      if (payWith === "other") await confirmOther();
      else await confirmGasless(payWith);
    } catch (e) {
      const m = friendlyPayError(e);
      setState("error");
      setMsg(m);
      report({ paid: false, error: m });
    }
  };

  const busy = state === "quoting" || state === "signing" || state === "settling" || state === "polling";
  const payLabel = payWith === "other"
    ? `${output.partnerOrder?.coin ?? ""} · ${output.partnerOrder?.network ?? ""}`
    : `USDC · ${RAIL_LABEL[payWith]} · no gas`;

  return (
    <div className="my-2 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg" style={{ backgroundColor: output.logoBg ?? "#2A2B27" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={output.logoUrl ?? "/cryptorefills-logo.png"} alt="" className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#F2F0E8]">{output.productName}</p>
          <p className="mt-0.5 truncate text-xs text-[#A7A79A]">To {output.recipient} · Cryptorefills</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-bold text-[#F2F0E8]">{usd(output.priceUsd)}</p>
          <p className="text-[10px] text-[#A7A79A]">{payLabel}</p>
        </div>
      </div>

      {state === "idle" && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => { setState("error"); setMsg("Cancelled. Nothing was charged."); report({ paid: false, error: "Cancelled by user" }); }}
            className="flex-1 rounded-xl bg-white/[0.06] py-2.5 text-xs font-semibold text-[#F2F0E8]"
          >Cancel</button>
          <button onClick={confirm} className="flex-1 rounded-xl bg-[#8FAE82] py-2.5 text-xs font-semibold text-[#141513]">
            {isOther ? "Get payment address" : "Confirm & pay"}
          </button>
        </div>
      )}

      {busy && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[#A7A79A]">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
          {state === "quoting" ? (isOther ? "Getting your payment address…" : "Creating your order…")
            : state === "signing" ? "Approve the payment in your wallet"
            : state === "settling" ? `Settling USDC on ${RAIL_LABEL[payWith === "solana" ? "solana" : "base"]}…`
            : `Paid. Waiting for delivery…${order ? ` (${order.order_id})` : ""}`}
        </div>
      )}

      {state === "confirmPrice" && priceConfirm && (
        <div className="mt-3">
          <p className="text-xs text-[#F2F0E8]">The price changed to {usd(priceConfirm.amount)}. Pay the new price?</p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => priceConfirm.resolve(false)} className="flex-1 rounded-xl bg-white/[0.06] py-2 text-xs font-semibold text-[#F2F0E8]">Cancel</button>
            <button onClick={() => priceConfirm.resolve(true)} className="flex-1 rounded-xl bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513]">Pay {usd(priceConfirm.amount)}</button>
          </div>
        </div>
      )}

      {state === "deposit" && deposit && (
        <div className="mt-3">
          <DepositPanel order={deposit} state={depositState} />
        </div>
      )}

      {state === "error" && msg && <p className="mt-3 text-xs text-red-400">{msg}</p>}

      {state === "done" && order && (
        <div className="mt-3">
          <Delivered order={order} email={email} />
        </div>
      )}
    </div>
  );
}
