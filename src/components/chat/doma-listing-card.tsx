"use client";

import { useEffect, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { payEvm, waitForEvmTx, evmPublicClient, friendlyEvmError } from "@/lib/evm-pay";
import { authFetch } from "@/lib/api-auth-fetch";
import { ChainTopUpPanel } from "@/components/dashboard/chain-topup-panel";
import { isSwapChain, type SwapChain } from "@/lib/swap-chains";
import { usePrivy } from "@privy-io/react-auth";
import {
  LISTING_CHAINS,
  SEAPORT_ADDRESS,
  SEAPORT_ABI,
  SEAPORT_CONDUIT_CONTROLLER,
  CONDUIT_CONTROLLER_ABI,
  ZERO_BYTES32,
  DOMA_BRIDGE_URL,
  domaChain,
  listingPayment,
  toAdvancedOrder,
  type DomaListingFulfillment,
} from "@/lib/doma-chain";

/**
 * Buy card for the AI's doma_buy_listing tool — fills a Doma marketplace
 * listing (a Seaport 1.6 order) from the user's own wallet:
 *   1. re-fetch the fulfillment for THIS wallet (Doma's zone signature is bound
 *      to the buyer and short-lived),
 *   2. check the token balance and gas on the listing's chain,
 *   3. approve the payment token to Seaport (or the order's conduit) if needed,
 *   4. simulate, then send fulfillAdvancedOrder — the domain goes to the buyer.
 * Nothing is sent until the user taps Buy. Reports {paid, txHash} to the chat.
 */

type Output = {
  domaListingBuy: true;
  listing: {
    name: string;
    externalId: string;
    chainId: number;
    chainName: string;
    expiresAt?: string;
    symbol: string;
    decimals: number;
    priceDisplay: number;
  };
  payment: { token: Hex | "native"; amount: string };
  buyer: string;
  /** Base listings only: top up the Base wallet from Arc / Tempo / Robinhood / XRP / Zcash / Hyperliquid first. */
  fundFrom?: SwapChain;
  refundAddress?: string;
  paid?: boolean;
  txHash?: string;
  error?: string;
};

type State = "idle" | "preparing" | "approving" | "buying" | "done" | "error";

export function DomaListingCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: Output;
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
}) {
  const { wallets } = useWallets();
  const { getAccessToken, sendTransaction } = usePrivy();
  const [state, setState] = useState<State>(output.paid === true ? "done" : output.paid === false ? "error" : "idle");
  const [msg, setMsg] = useState<string | null>(output.paid === false ? output.error ?? "The purchase didn't go through." : null);
  const [txHash, setTxHash] = useState<string | undefined>(output.txHash);

  const { listing } = output;
  const chain = LISTING_CHAINS[listing.chainId];
  const price = `${listing.priceDisplay.toLocaleString(undefined, { maximumFractionDigits: listing.decimals > 6 ? 6 : 2 })} ${listing.symbol}`;
  const expired = listing.expiresAt ? new Date(listing.expiresAt).getTime() < Date.now() : false;

  const report = (result: Record<string, unknown>) =>
    addToolResult({ tool: "doma_buy_listing", toolCallId, output: { ...output, ...result } });

  // Base listings priced in ETH or USDC can be funded from another chain.
  const topUpToken = listing.chainId === 8453 ? (output.payment.token === "native" ? "eth" : /usdc/i.test(listing.symbol) ? "usdc" : null) : null;
  const topUpAmount = topUpToken ? (Number(BigInt(output.payment.amount)) / 10 ** listing.decimals).toFixed(topUpToken === "eth" ? 6 : 2) : "0";
  const [showTopUp, setShowTopUp] = useState(!!topUpToken && isSwapChain(output.fundFrom));
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  useEffect(() => {
    if (topUpToken !== "eth" || !showTopUp || ethUsd !== null) return;
    authFetch("/api/prices", undefined, getAccessToken)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { prices?: { symbol: string; priceUsd: number }[] } | null) => {
        const p = d?.prices?.find((x) => x.symbol === "ETH")?.priceUsd;
        if (p) setEthUsd(p);
      })
      .catch(() => {});
  }, [topUpToken, showTopUp, ethUsd, getAccessToken]);
  const topUpUsd = topUpToken === "usdc" ? Number(topUpAmount) : ethUsd ? Number(topUpAmount) * ethUsd : null;

  const buy = async () => {
    setMsg(null);
    try {
      if (!chain) throw new Error("This listing is on a chain Bluvfi can't pay on.");
      const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
      if (!wallet) throw new Error("No wallet connected.");
      const buyer = wallet.address as Hex;
      if (buyer.toLowerCase() !== output.buyer.toLowerCase()) throw new Error("Your wallet changed. Ask the assistant to set up the purchase again.");

      // 1. Fresh fulfillment for this buyer.
      setState("preparing");
      const res = await authFetch("/api/doma/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "getListingFulfillment", payload: { orderId: listing.externalId, buyer } }),
      }, getAccessToken);
      const data = await res.json();
      if (!res.ok) throw new Error(/not found/i.test(data.error ?? "") ? "This listing is no longer available — it may have just sold." : data.error ?? "Couldn't load the listing.");
      const fulfillment = data.result as DomaListingFulfillment;
      const { token, amount } = listingPayment(fulfillment);
      // Never pay more than the user was shown.
      if (amount > BigInt(output.payment.amount)) throw new Error("The price changed. Ask the assistant to check the listing again.");
      const native = token === "native";

      // 2. Balances on the listing's chain.
      const pub = evmPublicClient(chain.id);
      const gas = await pub.getBalance({ address: buyer });
      const bal = native ? gas : await pub.readContract({ address: token as Hex, abi: erc20Abi, functionName: "balanceOf", args: [buyer] });
      const bridge = chain.id === domaChain.id ? ` Bridge funds at ${DOMA_BRIDGE_URL}, then try again.` : " Add funds, then try again.";
      if (bal < amount) throw new Error(`You need ${price} on ${chain.name}.${bridge}`);
      // No gas check here: Layer 1 (sponsored) doesn't need ETH; Layer 2 checks it itself.
      // Every send below goes through the shared fallback (sponsored → user gas); see lib/evm-pay.ts.

      // 3. Approve the token to whoever Seaport pulls through: itself for a zero conduit key, else the order's conduit.
      if (!native) {
        let spender: Hex = SEAPORT_ADDRESS;
        const conduitKey = fulfillment.order.parameters.conduitKey;
        if (conduitKey && conduitKey !== ZERO_BYTES32) {
          const [conduit, exists] = await pub.readContract({ address: SEAPORT_CONDUIT_CONTROLLER, abi: CONDUIT_CONTROLLER_ABI, functionName: "getConduit", args: [conduitKey] });
          if (!exists) throw new Error("This listing uses an unknown conduit.");
          spender = conduit;
        }
        const allowance = await pub.readContract({ address: token as Hex, abi: erc20Abi, functionName: "allowance", args: [buyer, spender] });
        if (allowance < amount) {
          setState("approving");
          const { hash: approveHash } = await payEvm({
            payment: { chainId: chain.id, to: token as Hex, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) },
            wallet, sendTransaction, label: "doma-listing",
          });
          await waitForEvmTx(chain.id, approveHash);
        }
      }

      // 4. Simulate first so a stale or sold listing fails here, not on-chain.
      setState("buying");
      const order = toAdvancedOrder(fulfillment);
      await pub.simulateContract({
        account: buyer,
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: "fulfillAdvancedOrder",
        args: [order, [], ZERO_BYTES32, buyer],
        ...(native ? { value: amount } : {}),
      });
      const { hash } = await payEvm({
        payment: {
          chainId: chain.id,
          to: SEAPORT_ADDRESS,
          data: encodeFunctionData({ abi: SEAPORT_ABI, functionName: "fulfillAdvancedOrder", args: [order, [], ZERO_BYTES32, buyer] }),
          ...(native ? { value: amount } : {}),
        },
        wallet, sendTransaction, label: "doma-listing",
      });
      await waitForEvmTx(chain.id, hash);
      setTxHash(hash);
      setState("done");
      authFetch("/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "domain",
          referenceId: listing.externalId,
          description: `Doma marketplace: bought ${listing.name} for ${price} on ${listing.chainName}`,
          amountUsdc: /usd/i.test(listing.symbol) ? String(listing.priceDisplay) : "0",
          status: "completed",
          txHash: hash,
          chain: chain.id === 8453 ? "evm" : "doma",
        }),
      }, getAccessToken).catch(() => {});
      report({ paid: true, txHash: hash });
    } catch (e) {
      const raw = (e as Error)?.message ?? "Purchase failed.";
      let m = /OrderAlreadyFilled|0x1a515574|already filled/i.test(raw)
        ? "Someone else bought this listing first. Nothing was charged."
        : friendlyEvmError(e, chain?.name);
      if (/gas/i.test(m) && chain?.id === domaChain.id) m += ` Bridge a little ETH at ${DOMA_BRIDGE_URL}, then try again.`;
      setState("error");
      setMsg(m);
      report({ paid: false, error: m });
    }
  };

  const busy = state === "preparing" || state === "approving" || state === "buying";

  return (
    <div className="my-2 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-lg">🏷️</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#F2F0E8]">{listing.name}</p>
          <p className="text-xs text-[#A7A79A]">Doma marketplace · {listing.chainName}</p>
        </div>
        <p className="shrink-0 text-sm font-bold text-[#F2F0E8]">{price}</p>
      </div>

      {state === "idle" && (
        expired ? (
          <p className="mt-3 text-xs text-amber-400/90">This listing has expired. Ask the assistant to look for it again.</p>
        ) : (
          <>
            <p className="mt-3 text-[11px] text-[#A7A79A]">
              Paid from your wallet on {listing.chainName}{output.payment.token === "native" ? "" : " (approve, then buy)"}. The domain is sent to your wallet.
            </p>
            {topUpToken && showTopUp && (
              <div className="mt-3">
                {topUpUsd === null ? (
                  <p className="text-[11px] text-[#A7A79A]">Getting the ETH price…</p>
                ) : (
                  <ChainTopUpPanel
                    token={topUpToken}
                    amount={topUpAmount}
                    amountUsd={topUpUsd}
                    purpose="doma"
                    reference={`${listing.name} (${price})`}
                    initialChain={isSwapChain(output.fundFrom) ? output.fundFrom : undefined}
                    initialRefundAddress={output.refundAddress}
                    onFunded={() => { setShowTopUp(false); void buy(); }}
                  />
                )}
              </div>
            )}
            {topUpToken && !showTopUp && (
              <button onClick={() => setShowTopUp(true)} className="mt-2 text-[11px] text-[#8FAE82] underline">
                Pay from Arc, Tempo, Robinhood Chain, XRP, Zcash or Hyperliquid instead
              </button>
            )}
            <div className={`mt-3 flex gap-2 ${topUpToken && showTopUp ? "hidden" : ""}`}>
              <button
                onClick={() => { setState("error"); setMsg("Cancelled. Nothing was sent."); report({ paid: false, error: "Cancelled by user" }); }}
                className="flex-1 rounded-xl bg-white/[0.06] py-2.5 text-xs font-semibold text-[#F2F0E8]"
              >Cancel</button>
              <button onClick={buy} className="flex-1 rounded-xl bg-[#8FAE82] py-2.5 text-xs font-semibold text-[#141513]">Buy for {price}</button>
            </div>
          </>
        )
      )}

      {busy && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[#A7A79A]">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
          {state === "preparing" ? "Checking the listing and your balance…"
            : state === "approving" ? `Approve ${listing.symbol} in your wallet (1 of 2)…`
            : `Confirm the purchase in your wallet${output.payment.token === "native" ? "" : " (2 of 2)"}…`}
        </div>
      )}

      {state === "done" && (
        <p className="mt-3 text-xs text-[#F2F0E8]">
          ✅ {listing.name} is yours.{" "}
          {txHash && chain?.blockExplorers && (
            <a href={`${chain.blockExplorers.default.url}/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="text-[#8FAE82] underline">View transaction</a>
          )}
        </p>
      )}

      {state === "error" && msg && <p className="mt-3 text-xs text-red-400">{msg}</p>}
    </div>
  );
}
