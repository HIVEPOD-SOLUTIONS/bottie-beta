/**
 * Bluvfi's ledger of every bluvfi-xrpl swap from Zcash, Hyperliquid, Arc,
 * Robinhood Chain or Tempo (table chain_swaps). The point is that no payment
 * sent through one of these chains can go untracked:
 *
 *   - every swap is recorded the moment it is created, with its deposit
 *     address, refund address and amounts;
 *   - the user's own transaction hash is saved BEFORE it is reported to
 *     bluvfi-xrpl, and a failed report is retried on every later refresh;
 *   - rows are refreshed from bluvfi-xrpl by the xrpl webhook, by status
 *     polls, and whenever the app or the AI lists them — so a payment whose
 *     tab was closed still ends up with its true status;
 *   - payments (History) and bitrefill_orders are kept in step.
 *
 * bluvfi-xrpl remains the source of truth (and NEAR Intents / LI.FI refund a
 * failed swap to refundAddress on their own); this copy is for tracing and
 * for telling the user exactly where their funds are.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chainSwaps, payments } from "@/lib/db/schema";
import { getWalletRequest, reportRouteTransaction, type XrplWallet } from "@/lib/xrplBackend";
import { markXrpPurchaseFailed } from "@/lib/xrp-purchase";
import { SWAP_CHAIN_META, isSwapChain } from "@/lib/swap-chains";
import { swapProgress, type SwapProgress } from "@/lib/swap-server";

export type ChainSwapRow = typeof chainSwaps.$inferSelect;
export type ChainSwapPurpose = "bitrefill" | "cryptorefills" | "stocks" | "doma" | "wallet";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const OPEN: SwapProgress[] = ["awaiting_payment", "processing"];

export async function recordChainSwap(row: {
  userId: string;
  wallet: XrplWallet;
  purpose: ChainSwapPurpose;
  reference?: string | null;
  chain: string;
  refundAddress: string;
  payAmount: string;
  paySymbol: string;
  recipient: string;
  receiveAmount: string;
  receiveAsset: string;
  amountUsd?: number;
}): Promise<void> {
  const kind = isSwapChain(row.chain) ? SWAP_CHAIN_META[row.chain].kind : "deposit";
  await db.insert(chainSwaps).values({
    userId: row.userId,
    walletRequestId: row.wallet.id,
    purpose: row.purpose,
    reference: row.reference ?? null,
    chain: row.chain,
    kind,
    depositAddress: kind === "deposit" ? row.wallet.address : null,
    depositMemo: row.wallet.depositMemo ?? null,
    refundAddress: row.refundAddress,
    payAmount: row.payAmount,
    paySymbol: row.paySymbol,
    recipient: row.recipient,
    receiveAmount: row.receiveAmount,
    receiveAsset: row.receiveAsset,
    amountUsd: row.amountUsd != null ? row.amountUsd.toFixed(2) : null,
    status: swapProgress(row.wallet.swapStatus),
    swapStatus: row.wallet.swapStatus,
    expiresAt: row.wallet.swapExpiresAt ? new Date(row.wallet.swapExpiresAt) : null,
  }).onConflictDoNothing({ target: chainSwaps.walletRequestId });
}

export async function getOwnedChainSwap(userId: string, walletRequestId: string): Promise<ChainSwapRow | null> {
  const [row] = await db.select().from(chainSwaps)
    .where(and(eq(chainSwaps.userId, userId), eq(chainSwaps.walletRequestId, walletRequestId)))
    .limit(1);
  return row ?? null;
}

/** Saves the user's own payment hash (wallet send to a deposit address, or a signed route). */
export async function saveUserTx(userId: string, walletRequestId: string, txHash: string): Promise<ChainSwapRow> {
  if (!TX_HASH.test(txHash)) throw new Error("Invalid transaction hash.");
  const row = await getOwnedChainSwap(userId, walletRequestId);
  if (!row) throw new Error("That payment wasn't found, or doesn't belong to this account.");
  if (row.userTxHash && row.userTxHash.toLowerCase() !== txHash.toLowerCase()) {
    throw new Error("A different transaction is already recorded for this payment.");
  }
  if (!row.userTxHash) {
    await db.update(chainSwaps).set({ userTxHash: txHash, updatedAt: new Date() }).where(eq(chainSwaps.id, row.id));
  }
  return { ...row, userTxHash: txHash };
}

/**
 * Route chains (Arc, Tempo): store the hash first, then hand it to
 * bluvfi-xrpl. If the report fails it is retried by refreshChainSwap(), so
 * the hash can never be lost between the user's wallet and the service.
 */
export async function reportRouteTx(userId: string, walletRequestId: string, txHash: string): Promise<{ reported: boolean }> {
  const row = await saveUserTx(userId, walletRequestId, txHash);
  if (row.kind !== "route") throw new Error("Only signed-route payments report a transaction.");
  return { reported: await tryReport(row) };
}

async function tryReport(row: ChainSwapRow): Promise<boolean> {
  if (row.kind !== "route" || !row.userTxHash || row.reportedAt) return !!row.reportedAt;
  try {
    await reportRouteTransaction(row.walletRequestId, row.userTxHash);
    await db.update(chainSwaps).set({ reportedAt: new Date(), updatedAt: new Date() }).where(eq(chainSwaps.id, row.id));
    return true;
  } catch (err) {
    console.error(`[chain-swaps] report of ${row.walletRequestId} failed (will retry):`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Pulls the latest status from bluvfi-xrpl and brings chain_swaps, payments and bitrefill_orders in step. */
export async function refreshChainSwap(row: ChainSwapRow): Promise<ChainSwapRow> {
  if (row.kind === "route" && row.userTxHash && !row.reportedAt) await tryReport(row);

  let wallet: XrplWallet;
  try {
    wallet = await getWalletRequest(row.walletRequestId);
  } catch {
    return row; // service unreachable — keep what we have, try again next time
  }
  const status = swapProgress(wallet.swapStatus);
  const error = status === "failed" || status === "expired" ? wallet.swapErrorMessage ?? null : null;
  const changed = status !== row.status || wallet.swapStatus !== row.swapStatus || (wallet.swapTxHash ?? null) !== row.swapTxHash;
  if (!changed) return row;

  const updated = { status, swapStatus: wallet.swapStatus, swapTxHash: wallet.swapTxHash ?? null, error, updatedAt: new Date() };
  await db.update(chainSwaps).set(updated).where(eq(chainSwaps.id, row.id));

  if (row.purpose === "bitrefill") {
    // Failure handling shared with XRP purchases (bitrefill_orders + payments).
    // Completion is set by Bitrefill's own webhook, not by the swap landing.
    if (status === "failed" || status === "expired") {
      await markXrpPurchaseFailed(row.walletRequestId, status).catch(() => {});
    }
  } else if (status === "completed" || status === "failed" || status === "expired") {
    await db.update(payments)
      .set({ status: status === "completed" ? "completed" : "failed", ...(wallet.swapTxHash ? { txHash: wallet.swapTxHash } : row.userTxHash ? { txHash: row.userTxHash } : {}) })
      .where(and(eq(payments.userId, row.userId), eq(payments.referenceId, row.walletRequestId)))
      .catch(() => {});
  }
  return { ...row, ...updated };
}

/** Called by the xrpl webhook for any event: refresh the row if this swap is one of ours. */
export async function refreshByWalletRequestId(walletRequestId: string): Promise<void> {
  const [row] = await db.select().from(chainSwaps).where(eq(chainSwaps.walletRequestId, walletRequestId)).limit(1);
  if (row) await refreshChainSwap(row);
}

/** The user's chain payments, newest first, with every still-open one refreshed first. */
export async function listUserChainSwaps(userId: string, limit = 20): Promise<ChainSwapRow[]> {
  const rows = await db.select().from(chainSwaps).where(eq(chainSwaps.userId, userId)).orderBy(desc(chainSwaps.createdAt)).limit(limit);
  const open = rows.filter((r) => OPEN.includes(r.status as SwapProgress) || (r.kind === "route" && r.userTxHash && !r.reportedAt));
  if (!open.length) return rows;
  const fresh = new Map((await Promise.all(open.map((r) => refreshChainSwap(r).catch(() => r)))).map((r) => [r.id, r]));
  return rows.map((r) => fresh.get(r.id) ?? r);
}

/** Plain-language "where is my money" for one row — shared by the API and the AI. */
export function describeChainSwap(row: ChainSwapRow): { summary: string; fundsAt: string; explorer: string | null } {
  const meta = isSwapChain(row.chain) ? SWAP_CHAIN_META[row.chain] : null;
  const label = meta?.label ?? row.chain;
  const paid = `${row.payAmount} ${row.paySymbol} on ${label}`;
  const explorer = row.userTxHash && meta ? meta.explorerTx(row.userTxHash) : null;
  const toWallet = row.purpose !== "bitrefill";
  switch (row.status) {
    case "completed":
      return toWallet
        ? { summary: `Done — ${row.receiveAmount} ${row.receiveAsset} arrived in the Bluvfi wallet.`, fundsAt: `Bluvfi wallet (${row.recipient})`, explorer }
        : { summary: `The ${paid} payment was delivered to the Bitrefill invoice.`, fundsAt: "Delivered to Bitrefill", explorer };
    case "processing":
      return { summary: `${paid} was received and is being converted — usually a minute or two.`, fundsAt: "In transit", explorer };
    case "failed":
    case "expired":
      return {
        summary: `${row.status === "expired" ? "The payment window closed" : "The payment couldn't complete"}. Anything sent is refunded automatically to ${row.refundAddress}${row.swapTxHash ? ` (refund tx ${row.swapTxHash})` : ""}.`,
        fundsAt: row.userTxHash || row.swapStatus === "REFUNDED" ? `Refunded to ${row.refundAddress}` : "Nothing was sent, or it is being refunded",
        explorer,
      };
    default:
      return {
        summary: row.kind === "route"
          ? row.userTxHash ? `Signed (${row.userTxHash}); waiting for the network to pick it up.` : "Prepared, not signed yet — nothing has left the wallet."
          : `Waiting for ${paid} to arrive at ${row.depositAddress}${row.depositMemo ? ` (memo ${row.depositMemo})` : ""}.`,
        fundsAt: row.userTxHash ? "Sent, awaiting confirmation" : "Not sent yet",
        explorer,
      };
  }
}
