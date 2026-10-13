/**
 * Browser half of Bitrefill purchases paid with Zcash, Hyperliquid USDC or
 * Arc USDC (server half: src/lib/chain-purchase.ts). Shared by the Bills
 * checkout and the chat's Bitrefill card so both behave the same.
 */

import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { authFetch } from "@/lib/api-auth-fetch";
import { payEvm, waitForEvmTx, evmPublicClient, type SendTransaction, type PayLayer } from "@/lib/evm-pay";
import { arcChain } from "@/lib/arc-chain";
import type { ChainPurchaseResult, PurchaseChain } from "@/lib/chain-purchase";

export type { ChainPurchaseResult, PurchaseChain };

/** Display data for the three chains — mirrors CHAIN_META on the server. */
export const PURCHASE_CHAIN_UI: Record<PurchaseChain, { label: string; symbol: string; needsRefundAddress: boolean; refundPlaceholder: string; refundPattern: RegExp; refundHint: string; howToPay: string }> = {
  zcash: {
    label: "Zcash",
    symbol: "ZEC",
    needsRefundAddress: true,
    refundPlaceholder: "Your Zcash address (t1…)",
    refundPattern: /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/,
    refundHint: "a transparent Zcash address (starts with t1 or t3)",
    howToPay: "Send ZEC from your own Zcash wallet (transparent send).",
  },
  hyperliquid: {
    label: "Hyperliquid",
    symbol: "USDC",
    needsRefundAddress: true,
    refundPlaceholder: "Your Hyperliquid address (0x…)",
    refundPattern: /^0x[0-9a-fA-F]{40}$/,
    refundHint: "your Hyperliquid account address (0x…)",
    howToPay: "Send USDC from your Hyperliquid spot balance (Send → paste the address).",
  },
  arc: {
    label: "Arc",
    symbol: "USDC",
    needsRefundAddress: false,
    refundPlaceholder: "",
    refundPattern: /^0x[0-9a-fA-F]{40}$/,
    refundHint: "your Bluvfi wallet address",
    howToPay: "Paid from your Bluvfi wallet's USDC on Arc — just confirm.",
  },
};

export type PurchaseRequestBody = {
  chain: PurchaseChain;
  refundAddress: string;
  productId: string;
  packageId?: string;
  customValue?: number;
  recipientEmail?: string;
  recipientName?: string;
  sendTo?: string;
};

type GetAccessToken = () => Promise<string | null>;

export async function startChainPurchase(body: PurchaseRequestBody, getAccessToken: GetAccessToken): Promise<ChainPurchaseResult> {
  const res = await authFetch("/api/bitrefill/chain-purchase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, getAccessToken);
  const data = await res.json().catch(() => ({ error: "Purchase failed" }));
  if (!res.ok) throw new Error(data.error ?? "Purchase failed");
  return data as ChainPurchaseResult;
}

/**
 * Arc: signs the route bluvfi-xrpl returned with the user's Bluvfi wallet —
 * the USDC approval (only if the current allowance is short), then the swap
 * transaction — and reports the hash so the swap can be tracked. Both go
 * through the shared 3-layer helper. USDC is Arc's gas token, so a funded
 * wallet needs nothing else.
 */
export async function payArcPurchase(opts: {
  purchase: ChainPurchaseResult;
  wallet: ConnectedWallet;
  sendTransaction: SendTransaction;
  getAccessToken: GetAccessToken;
  onStage?: (stage: "approving" | "paying" | "confirming", layer?: PayLayer) => void;
}): Promise<Hex> {
  const { purchase, wallet, sendTransaction, getAccessToken, onStage } = opts;
  const p = purchase.payment;
  if (!p?.transactionRequest?.to || !p.transactionRequest.data) throw new Error("This Arc payment has no transaction to sign.");
  if (wallet.address.toLowerCase() !== purchase.refundAddress.toLowerCase()) {
    throw new Error("This payment was prepared for a different wallet. Please start again.");
  }
  if (p.chainId !== arcChain.id) throw new Error("This payment targets an unexpected network.");

  const account = wallet.address as Hex;
  const client = evmPublicClient(arcChain.id);

  if (p.approval) {
    const token = p.approval.token as Hex;
    const spender = p.approval.spender as Hex;
    const needed = BigInt(p.approval.amount);
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender] });
    if (allowance < needed) {
      onStage?.("approving");
      // Exactly the amount — never an unlimited approval to a router.
      const { hash } = await payEvm({
        payment: { chainId: arcChain.id, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, needed] }) },
        wallet,
        sendTransaction,
        onLayer: (l) => onStage?.("approving", l),
        label: "arc-purchase-approve",
      });
      await waitForEvmTx(arcChain.id, hash);
    }
  }

  onStage?.("paying");
  const tx = p.transactionRequest;
  const { hash } = await payEvm({
    payment: {
      chainId: arcChain.id,
      to: tx.to as Hex,
      data: tx.data as Hex,
      ...(tx.value && BigInt(tx.value) > 0n ? { value: BigInt(tx.value) } : {}),
    },
    wallet,
    sendTransaction,
    onLayer: (l) => onStage?.("paying", l),
    label: "arc-purchase",
  });

  // Report straight away (before waiting): a mined-but-unreported route can't be tracked.
  onStage?.("confirming");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await authFetch(`/api/bitrefill/chain-purchase/${encodeURIComponent(purchase.walletRequestId)}/transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: hash }),
    }, getAccessToken).catch(() => null);
    if (res?.ok) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  await waitForEvmTx(arcChain.id, hash).catch(() => {});
  return hash;
}
