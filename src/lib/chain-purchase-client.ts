/**
 * Browser half of swaps from Zcash, Hyperliquid, Arc, Robinhood Chain and
 * Tempo (server half: swap-server.ts, chain-purchase.ts, chain-topup.ts).
 * Shared by the Bills checkout, the wallet top-up panel used by Cryptorefills
 * / Backpack / Doma, and the chat cards, so they all behave the same.
 */

import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import type { ConnectedWallet } from "@privy-io/react-auth";
import { authFetch } from "@/lib/api-auth-fetch";
import { payEvm, payEvmTransfer, waitForEvmTx, evmPublicClient, type SendTransaction, type PayLayer } from "@/lib/evm-pay";
import { SWAP_CHAIN_META, type SwapChain } from "@/lib/swap-chains";
import type { XrplWallet } from "@/lib/xrplBackend";
import type { ChainPurchaseResult, PurchaseChain } from "@/lib/chain-purchase";

export type { ChainPurchaseResult, PurchaseChain };

/** Display data for every swap chain (see swap-chains.ts). */
export const PURCHASE_CHAIN_UI = SWAP_CHAIN_META;

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

export type RouteStage = "approving" | "paying" | "confirming";

// Signed-but-unreported route hashes, kept in this browser until the server
// has them (it then stores them and keeps retrying bluvfi-xrpl itself).
const PENDING_KEY = "bluvfi_pending_route_reports";
type PendingReport = { url: string; txHash: string; at: number };

function readPending(): PendingReport[] {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]") as PendingReport[]; } catch { return []; }
}
function writePending(list: PendingReport[]) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-20))); } catch { /* storage unavailable */ }
}

async function sendReport(url: string, txHash: string, getAccessToken: GetAccessToken): Promise<boolean> {
  const res = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash }),
  }, getAccessToken).catch(() => null);
  // 4xx means the server already has a decision on this hash (e.g. recorded, or not ours) — stop retrying.
  return !!res && (res.ok || (res.status >= 400 && res.status < 500));
}

/** Retries any route hash this browser signed but never got to the server. Call on app load. */
export async function retryPendingRouteReports(getAccessToken: GetAccessToken): Promise<void> {
  const list = readPending();
  if (!list.length) return;
  const keep: PendingReport[] = [];
  for (const p of list) {
    if (Date.now() - p.at > 7 * 86_400_000) continue; // a week old: give up locally
    if (!(await sendReport(p.url, p.txHash, getAccessToken))) keep.push(p);
  }
  writePending(keep);
}

/**
 * Route chains (Arc, Tempo): signs what bluvfi-xrpl returned with the Bluvfi
 * wallet — the token approval (exact amount, only if the allowance is short),
 * then the swap transaction — and reports the hash to `reportUrl` so the swap
 * can be tracked. Both go through the shared 3-layer helper.
 */
export async function payRouteSwap(opts: {
  chain: SwapChain;
  payment: XrplWallet["payment"] | null;
  /** The address the route was prepared for — must be the signing wallet. */
  refundAddress: string;
  reportUrl: string;
  wallet: ConnectedWallet;
  sendTransaction: SendTransaction;
  getAccessToken: GetAccessToken;
  onStage?: (stage: RouteStage, layer?: PayLayer) => void;
}): Promise<Hex> {
  const { chain, payment: p, wallet, sendTransaction, getAccessToken, onStage } = opts;
  const meta = SWAP_CHAIN_META[chain];
  if (meta.kind !== "route" || !meta.wallet) throw new Error(`${meta.label} payments aren't signed in the app.`);
  const chainId = meta.wallet.chainId;
  if (!p?.transactionRequest?.to || !p.transactionRequest.data) throw new Error(`This ${meta.label} payment has no transaction to sign.`);
  if (wallet.address.toLowerCase() !== opts.refundAddress.toLowerCase()) {
    throw new Error("This payment was prepared for a different wallet. Please start again.");
  }
  if (p.chainId !== chainId) throw new Error("This payment targets an unexpected network.");

  const account = wallet.address as Hex;
  if (p.approval) {
    const token = p.approval.token as Hex;
    const spender = p.approval.spender as Hex;
    const needed = BigInt(p.approval.amount);
    const allowance = await evmPublicClient(chainId).readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender] });
    if (allowance < needed) {
      onStage?.("approving");
      // Exactly the amount — never an unlimited approval to a router.
      const { hash } = await payEvm({
        payment: { chainId, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, needed] }) },
        wallet,
        sendTransaction,
        onLayer: (l) => onStage?.("approving", l),
        label: `${chain}-approve`,
      });
      await waitForEvmTx(chainId, hash);
    }
  }

  onStage?.("paying");
  const tx = p.transactionRequest;
  const { hash } = await payEvm({
    payment: {
      chainId,
      to: tx.to as Hex,
      data: tx.data as Hex,
      ...(tx.value && BigInt(tx.value) > 0n ? { value: BigInt(tx.value) } : {}),
    },
    wallet,
    sendTransaction,
    onLayer: (l) => onStage?.("paying", l),
    label: `${chain}-route`,
  });

  // Report straight away (before waiting): a mined-but-unreported route can't be tracked.
  // Kept locally until the server confirms it, and retried on the next app load.
  onStage?.("confirming");
  writePending([...readPending(), { url: opts.reportUrl, txHash: hash, at: Date.now() }]);
  let delivered = false;
  for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
    delivered = await sendReport(opts.reportUrl, hash, getAccessToken);
    if (!delivered) await new Promise((r) => setTimeout(r, 1500));
  }
  if (delivered) writePending(readPending().filter((p) => p.txHash !== hash));
  await waitForEvmTx(chainId, hash).catch(() => {});
  return hash;
}

/**
 * Deposit chains the Bluvfi wallet can pay on (Robinhood Chain ETH): sends
 * exactly `amount` to the deposit address with the shared 3-layer helper.
 */
export async function payDepositFromWallet(opts: {
  chain: SwapChain;
  depositAddress: string;
  amount: string;
  wallet: ConnectedWallet;
  sendTransaction: SendTransaction;
  /** Records the hash on the swap's ledger row so the transfer stays traceable. */
  track?: { walletRequestId: string; getAccessToken: GetAccessToken };
}): Promise<Hex> {
  const meta = SWAP_CHAIN_META[opts.chain];
  if (meta.kind !== "deposit" || !meta.wallet) throw new Error(`${meta.label} can't be paid from the Bluvfi wallet.`);
  const { hash } = await payEvmTransfer({
    chainId: meta.wallet.chainId,
    token: meta.wallet.token,
    symbol: meta.symbol,
    decimals: meta.wallet.tokenDecimals,
    recipient: opts.depositAddress as Hex,
    amount: opts.amount,
    wallet: opts.wallet,
    sendTransaction: opts.sendTransaction,
    label: `${opts.chain}-deposit`,
  });
  if (opts.track) {
    // Before waiting: the hash is what lets anyone trace this transfer later.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await authFetch(`/api/chain-swaps/${encodeURIComponent(opts.track.walletRequestId)}/user-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: hash }),
      }, opts.track.getAccessToken).catch(() => null);
      if (res?.ok) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await waitForEvmTx(meta.wallet.chainId, hash).catch(() => {});
  return hash;
}

/** Bitrefill route purchase (Arc) — kept for existing callers. */
export function payArcPurchase(opts: {
  purchase: ChainPurchaseResult;
  wallet: ConnectedWallet;
  sendTransaction: SendTransaction;
  getAccessToken: GetAccessToken;
  onStage?: (stage: RouteStage, layer?: PayLayer) => void;
}): Promise<Hex> {
  return payRouteSwap({
    chain: opts.purchase.chain,
    payment: opts.purchase.payment,
    refundAddress: opts.purchase.refundAddress,
    reportUrl: `/api/bitrefill/chain-purchase/${encodeURIComponent(opts.purchase.walletRequestId)}/transaction`,
    wallet: opts.wallet,
    sendTransaction: opts.sendTransaction,
    getAccessToken: opts.getAccessToken,
    onStage: opts.onStage,
  });
}

/** The user's Bluvfi wallet balance of what a swap chain spends (null if it can't be read). */
export async function walletSwapBalance(chain: SwapChain, address: string): Promise<number | null> {
  const w = SWAP_CHAIN_META[chain].wallet;
  if (!w) return null;
  try {
    const client = evmPublicClient(w.chainId);
    const raw = w.token === "native"
      ? await client.getBalance({ address: address as Hex })
      : await client.readContract({ address: w.token, abi: erc20Abi, functionName: "balanceOf", args: [address as Hex] });
    return Number(raw) / 10 ** w.tokenDecimals;
  } catch {
    return null;
  }
}
