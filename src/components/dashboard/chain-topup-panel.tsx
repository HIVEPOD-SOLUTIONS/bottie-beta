"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi, type Hex } from "viem";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { QRCodeSVG } from "qrcode.react";
import { authFetch } from "@/lib/api-auth-fetch";
import { evmPublicClient, friendlyEvmError, pickPrivyWalletOrThrow, pickPrivyWallet } from "@/lib/evm-pay";
import { MIN_DEPOSIT_SWAP_USD, SWAP_CHAIN_META, TOPUP_SWAP_CHAINS, type SwapChain } from "@/lib/swap-chains";
import { payDepositFromWallet, payRouteSwap, walletSwapBalance } from "@/lib/chain-purchase-client";
import type { TopUpResult, TopUpPurpose, TopUpToken } from "@/lib/chain-topup";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** The Bluvfi wallet's USDC or ETH on Base (null if it can't be read). */
async function baseBalance(token: TopUpToken, address: string): Promise<number | null> {
  try {
    const client = evmPublicClient(8453);
    if (token === "eth") return Number(await client.getBalance({ address: address as Hex })) / 1e18;
    return Number(await client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address as Hex] })) / 1e6;
  } catch {
    return null;
  }
}

/**
 * "Pay from another chain": tops up the Bluvfi wallet on Base with exactly
 * what a checkout is short of (it reads the Base balance first), from Arc, Tempo, Robinhood Chain, Zcash or
 * Hyperliquid (server: src/lib/chain-topup.ts). When the funds have arrived it
 * calls onFunded() and the provider's normal wallet payment carries on.
 *
 * Used by Cryptorefills, Backpack stocks and Doma Base listings, on screen and
 * in chat.
 */
export function ChainTopUpPanel({
  token,
  amount,
  amountUsd,
  purpose,
  onFunded,
  initialChain,
  initialRefundAddress,
  title = "Pay from another chain",
  reference,
}: {
  token: TopUpToken;
  /** Total decimal amount of `token` the checkout needs on Base (only the shortfall is topped up). */
  amount: string;
  /** USD value of `amount`. */
  amountUsd: number;
  purpose: TopUpPurpose;
  onFunded: () => void;
  initialChain?: SwapChain;
  initialRefundAddress?: string;
  title?: string;
  /** What this pays for (product, stock, domain) — stored with the top-up for tracing. */
  reference?: string;
}) {
  const { getAccessToken, sendTransaction } = usePrivy();
  const { wallets } = useWallets();
  const [chain, setChain] = useState<SwapChain>(initialChain ?? "arc");
  const [refund, setRefund] = useState(initialRefundAddress ?? "");
  const [stage, setStage] = useState<"pick" | "starting" | "signing" | "deposit" | "arriving" | "done" | "error">("pick");
  const [label, setLabel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [topUp, setTopUp] = useState<TopUpResult | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const fundedRef = useRef(false);

  const [onBase, setOnBase] = useState<number | null>(null);

  const meta = SWAP_CHAIN_META[chain];
  const evmAddress = pickPrivyWallet(wallets)?.address ?? null;
  const symbol = token === "eth" ? "ETH" : "USDC";
  const refundOk = !meta.needsRefundAddress || meta.refundPattern.test(refund.trim());

  useEffect(() => {
    if (!evmAddress) return;
    let live = true;
    baseBalance(token, evmAddress).then((b) => { if (live) setOnBase(b); });
    return () => { live = false; };
  }, [token, evmAddress, stage]);

  // Only the shortfall, plus 0.5% headroom for price moves; deposit chains
  // have a bridge minimum, so a small shortfall is rounded up to it (the rest
  // simply stays in the wallet).
  const { topUpAmount, topUpUsd, covered } = useMemo(() => {
    const need = Number(amount);
    const usdPerUnit = need > 0 ? amountUsd / need : 1;
    const short = onBase === null ? need : Math.max(0, need - onBase);
    let units = short * 1.005;
    let usd = units * usdPerUnit;
    if (meta.kind === "deposit" && usd < MIN_DEPOSIT_SWAP_USD) { usd = MIN_DEPOSIT_SWAP_USD; units = usd / usdPerUnit; }
    const dp = token === "eth" ? 6 : 2;
    const rounded = Math.ceil(units * 10 ** dp) / 10 ** dp;
    return { topUpAmount: rounded.toFixed(dp), topUpUsd: Math.round(usd * 100) / 100, covered: onBase !== null && short <= 0 };
  }, [amount, amountUsd, onBase, meta.kind, token]);

  // What the Bluvfi wallet already holds on the chosen chain (Arc, Tempo, Robinhood).
  useEffect(() => {
    setBalance(null);
    if (!evmAddress || !meta.wallet) return;
    let live = true;
    walletSwapBalance(chain, evmAddress).then((b) => { if (live) setBalance(b); });
    return () => { live = false; };
  }, [chain, evmAddress, meta.wallet]);

  // Poll the swap until it lands (or fails) once something was paid / shown.
  useEffect(() => {
    if (!topUp || (stage !== "deposit" && stage !== "arriving")) return;
    const check = async () => {
      try {
        const res = await authFetch(`/api/chain-topup/${encodeURIComponent(topUp.walletRequestId)}`, {}, getAccessToken);
        if (!res.ok) return;
        const data = (await res.json()) as { progress: string; error: string | null };
        if (data.progress === "processing" && stage === "deposit") setStage("arriving");
        if (data.progress === "completed" && !fundedRef.current) {
          fundedRef.current = true;
          setStage("done");
          onFunded();
        }
        if (data.progress === "failed" || data.progress === "expired") {
          setStage("error");
          setErr(`${data.progress === "expired" ? "The payment window closed." : "The top-up couldn't complete."} Anything you sent is refunded automatically to ${chain === "zcash" || chain === "hyperliquid" ? "your refund address" : `your Bluvfi wallet on ${meta.label}`}.`);
        }
      } catch { /* keep polling */ }
    };
    void check();
    const id = setInterval(check, 6000);
    return () => clearInterval(id);
  }, [topUp, stage, getAccessToken, onFunded, chain, meta.label]);

  const start = async () => {
    setErr(null);
    setStage("starting");
    try {
      const wallet = pickPrivyWalletOrThrow(wallets);
      const res = await authFetch("/api/chain-topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain,
          token,
          amount: topUpAmount,
          amountUsd: topUpUsd,
          recipient: wallet.address,
          refundAddress: meta.needsRefundAddress ? refund.trim() : undefined,
          purpose,
          reference,
        }),
      }, getAccessToken);
      const data = await res.json().catch(() => ({ error: "Top-up failed" }));
      if (!res.ok) throw new Error(data.error ?? "Top-up failed");
      const t = data as TopUpResult;
      setTopUp(t);
      if (meta.kind === "route") {
        setStage("signing");
        await payRouteSwap({
          chain,
          payment: t.payment,
          refundAddress: t.refundAddress,
          reportUrl: `/api/chain-topup/${encodeURIComponent(t.walletRequestId)}/transaction`,
          wallet,
          sendTransaction,
          getAccessToken,
          onStage: (s) => setLabel(s === "approving" ? `Approving ${meta.symbol}…` : s === "paying" ? `Paying ${t.amount} ${meta.symbol} on ${meta.label}…` : "Confirming…"),
        });
        setLabel(null);
        setStage("arriving");
      } else {
        setStage("deposit");
      }
    } catch (e) {
      // Nothing was paid (quote refused, or the signature was cancelled/failed):
      // back to the picker; a retry prices a fresh top-up.
      setErr(friendlyEvmError(e, meta.label));
      setTopUp(null);
      setLabel(null);
      setStage("pick");
    }
  };

  const sendFromWallet = async () => {
    if (!topUp?.depositAddress) return;
    setErr(null);
    setLabel(`Sending ${topUp.amount} ${meta.symbol}…`);
    try {
      await payDepositFromWallet({
        chain, depositAddress: topUp.depositAddress, amount: topUp.amount, wallet: pickPrivyWalletOrThrow(wallets), sendTransaction,
        track: { walletRequestId: topUp.walletRequestId, getAccessToken },
      });
      setStage("arriving");
    } catch (e) {
      setErr(friendlyEvmError(e, meta.label));
    } finally {
      setLabel(null);
    }
  };

  const copy = (v: string, what: string) => {
    navigator.clipboard.writeText(v).then(() => { setCopied(what); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  };

  return (
    <div className="rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-[#F2F0E8]">{title}</p>
        <span className="text-[10px] text-[#A7A79A]">{covered ? "Base wallet covered" : `${topUpAmount} ${symbol} → your wallet on Base`}</span>
      </div>

      {stage === "pick" && covered && (
        <div className="space-y-2">
          <p className="text-[11px] text-[#A7A79A]">Your Bluvfi wallet on Base already has {onBase?.toLocaleString(undefined, { maximumFractionDigits: 6 })} {symbol} — enough for this.</p>
          <button onClick={() => { fundedRef.current = true; onFunded(); }} className="w-full rounded-lg bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513]">Continue</button>
        </div>
      )}

      {stage === "pick" && !covered && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {TOPUP_SWAP_CHAINS.map((c) => {
              const m = SWAP_CHAIN_META[c];
              return (
                <button
                  key={c}
                  onClick={() => { setChain(c); setErr(null); }}
                  className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${chain === c ? "border-[#8FAE82] bg-[#8FAE82]/10 text-[#8FAE82]" : "border-[#2A2B27] text-[#A7A79A]"}`}
                >
                  {m.icon} {m.label} <span className="opacity-70">{m.symbol}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[10px] leading-relaxed text-[#A7A79A]">
            {meta.howToPay}
            {balance !== null && ` You have ${balance.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${meta.symbol} there.`}
          </p>
          {meta.needsRefundAddress && (
            <input
              value={refund}
              onChange={(e) => setRefund(e.target.value)}
              placeholder={meta.refundPlaceholder}
              spellCheck={false}
              className="w-full rounded-lg border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 font-mono text-[11px] text-[#F2F0E8] placeholder:text-[#A7A79A]/50 outline-none focus:border-[#8FAE82]"
            />
          )}
          {meta.needsRefundAddress && refund.trim() && !refundOk && (
            <p className="text-[10px] text-red-400">That isn&apos;t {meta.refundHint}.</p>
          )}
          {meta.kind === "deposit" && topUpUsd <= MIN_DEPOSIT_SWAP_USD && (
            <p className="text-[10px] text-[#A7A79A]">Top-ups from {meta.label} start at ${MIN_DEPOSIT_SWAP_USD.toFixed(2)}; anything extra stays in your wallet.</p>
          )}
          <button
            onClick={start}
            disabled={!refundOk}
            className="w-full rounded-lg bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513] disabled:opacity-50"
          >
            {meta.kind === "route" ? `Pay with ${meta.symbol} on ${meta.label}` : `Get ${meta.symbol} deposit address`}
          </button>
        </>
      )}

      {(stage === "starting" || stage === "signing") && (
        <p className="text-xs text-[#A7A79A]">{label ?? (stage === "starting" ? "Getting a live price…" : "Confirm in your wallet…")}</p>
      )}

      {stage === "deposit" && topUp?.depositAddress && (
        <div className="space-y-2">
          <div className="flex justify-center rounded-lg bg-white p-2">
            <QRCodeSVG value={topUp.depositAddress} size={128} level="M" includeMargin={false} />
          </div>
          <p className="text-[11px] text-[#A7A79A]">
            Send exactly <span className="font-mono font-semibold text-[#F2F0E8]">{topUp.amount} {meta.symbol}</span> on {meta.label} to:
          </p>
          <button onClick={() => copy(topUp.depositAddress!, "address")} className="w-full rounded-lg bg-[#1B1C19] px-3 py-2 text-left font-mono text-[10px] text-[#F2F0E8] break-all">
            {topUp.depositAddress} <span className="text-[#8FAE82]">{copied === "address" ? "✓ copied" : "copy"}</span>
          </button>
          {topUp.depositMemo && (
            <button onClick={() => copy(topUp.depositMemo!, "memo")} className="w-full rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-[10px] text-amber-300">
              Include memo: <span className="font-mono text-[#F2F0E8]">{topUp.depositMemo}</span> {copied === "memo" ? "✓" : "(copy)"}
            </button>
          )}
          {meta.wallet && (
            <button onClick={sendFromWallet} disabled={!!label} className="w-full rounded-lg bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513] disabled:opacity-50">
              {label ?? `Send from my Bluvfi wallet`}
            </button>
          )}
          <p className="text-[10px] text-[#A7A79A]">
            Waiting for your payment{topUp.expiresAt ? ` · send before ${new Date(topUp.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}. If it can&apos;t complete, it&apos;s refunded to {topUp.refundAddress.slice(0, 8)}…
          </p>
        </div>
      )}

      {stage === "arriving" && (
        <p className="text-xs text-[#A7A79A]">⏳ Payment received — {topUp?.receive.amount} {symbol} is on its way to your wallet on Base (usually a minute or two{chain === "zcash" ? "; Zcash confirmations can take longer" : ""}).</p>
      )}
      {stage === "done" && <p className="text-xs text-green-400">✓ {topUp?.receive.amount} {symbol} arrived on Base. Continuing…</p>}
      {err && <p className="text-[11px] text-red-400">{err}</p>}
      {stage === "error" && (
        <button onClick={() => { setStage("pick"); setTopUp(null); setErr(null); fundedRef.current = false; }} className="w-full rounded-lg border border-[#2A2B27] py-1.5 text-[11px] text-[#A7A79A]">
          Try again
        </button>
      )}
    </div>
  );
}
