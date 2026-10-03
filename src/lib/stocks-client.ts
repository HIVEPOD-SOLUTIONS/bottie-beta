"use client";

import type { ConnectedWallet } from "@privy-io/react-auth";
import { authFetch } from "@/lib/api-auth-fetch";
import { payEvmTransfer, type SendTransaction } from "@/lib/evm-pay";

/**
 * Browser half of a Backpack stock trade, shared by Invest → Stocks and the
 * AI chat's trade card. A buy pays with USDC from the user's wallet (gas
 * sponsored) in the same step; a sale's money goes back to the wallet
 * server-side once it settles.
 */

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

type GetAccessToken = () => Promise<string | null>;
export type { SendTransaction };

/** What /api/stocks/quote returns. */
export interface StockQuote {
  asset: string;
  name: string;
  side: "buy" | "sell";
  quantity: string;
  venue: "rfq" | "spot";
  marketPrice: number;
  limitPrice: string;
  estimateUsdc: string;
  feeUsdc: string;
}

export interface StockOrderView {
  id: string;
  status: string;
  fillPrice?: string | null;
  fillQuantity?: string | null;
  error?: string | null;
}

export type TradeStep = "funding" | "placing" | "pending";

/** USDC the wallet must send for a buy: the quote's max cost minus credit already held, rounded up to the cent. */
export function walletShare(quote: StockQuote, creditUsd: number): number {
  return quote.side === "buy" ? Math.max(0, Math.ceil((Number(quote.estimateUsdc) - creditUsd) * 100) / 100) : 0;
}

/**
 * Moves `amountUsd` of USDC (Base, gas sponsored) from the user's Bluvfi
 * wallet to Bluvfi's Backpack account and waits until the server has credited it.
 */
async function fundFromWallet(amountUsd: number, wallet: ConnectedWallet, sendTransaction: SendTransaction, getAccessToken: GetAccessToken) {
  const info = await authFetch("/api/stocks/deposit", undefined, getAccessToken).then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    return d as { address: `0x${string}` };
  });
  // Same 3-layer fallback as every other EVM payment (sponsored → user gas → Circle).
  const { hash } = await payEvmTransfer({
    chainId: 8453,
    token: BASE_USDC,
    symbol: "USDC",
    decimals: 6,
    recipient: info.address,
    amount: amountUsd.toFixed(2),
    wallet,
    sendTransaction,
    label: "stocks",
  });
  // The receipt can take a few seconds to be visible.
  for (let i = 0; i < 20; i++) {
    const r = await authFetch("/api/stocks/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: hash }),
    }, getAccessToken);
    if (r.ok) return;
    const d = await r.json().catch(() => ({}));
    if (r.status !== 404) throw new Error(d.error ?? "Couldn't confirm your payment.");
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("Your USDC was sent but isn't confirmed yet. It'll be saved as credit once it confirms — try the buy again in a minute.");
}

/** Polls an order until it leaves "pending" or ~2 minutes pass (deferred settlement can take a moment). */
export async function watchStockOrder(
  order: StockOrderView,
  getAccessToken: GetAccessToken,
  isAlive: () => boolean = () => true,
): Promise<StockOrderView> {
  for (let i = 0; i < 40 && order.status === "pending" && isAlive(); i++) {
    await new Promise((res) => setTimeout(res, 3000));
    const o = await authFetch(`/api/stocks/orders/${order.id}`, undefined, getAccessToken).then((x) => x.json()).catch(() => null);
    if (o?.order) order = o.order;
  }
  return order;
}

/**
 * Funds a buy from the wallet (whatever credit doesn't cover), places the
 * trade at the quoted price cap, and waits for it to settle.
 */
export async function executeStockTrade(opts: {
  quote: StockQuote;
  creditUsd: number;
  sendTransaction: SendTransaction;
  /** The Privy EVM wallet that pays (Layers 2–3 of the fallback). */
  wallet: ConnectedWallet;
  getAccessToken: GetAccessToken;
  onStep?: (s: TradeStep) => void;
  isAlive?: () => boolean;
}): Promise<StockOrderView> {
  const { quote, creditUsd, sendTransaction, wallet, getAccessToken, onStep, isAlive } = opts;
  const fromWallet = walletShare(quote, creditUsd);
  if (fromWallet > 0) {
    onStep?.("funding");
    await fundFromWallet(fromWallet, wallet, sendTransaction, getAccessToken);
  }
  onStep?.("placing");
  const r = await authFetch("/api/stocks/trade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset: quote.asset, side: quote.side, quantity: quote.quantity, limitPrice: quote.limitPrice }),
  }, getAccessToken);
  const d = await r.json();
  if (!r.ok) {
    // Money already moved in stays as credit for the next buy — say so.
    throw new Error(fromWallet > 0 ? `${d.error} Your $${fromWallet.toFixed(2)} is saved as credit for your next buy.` : d.error);
  }
  onStep?.("pending");
  return watchStockOrder(d.order, getAccessToken, isAlive);
}

/** One-line reason a non-filled order didn't go through. */
export function orderFailureMessage(order: StockOrderView, side: "buy" | "sell"): string {
  return order.status === "expired" || order.status === "cancelled"
    ? `No one filled the order within your price cap. ${side === "buy" ? "Your money is kept as credit for your next buy" : "Your shares are unchanged"}.`
    : order.error ?? "The order failed. Nothing was charged.";
}

export function friendlyTradeError(err: unknown): string {
  const m = (err as Error)?.message ?? "The trade failed.";
  return /reject|denied|cancel/i.test(m) ? "Cancelled. Nothing was sent." : m.split("\n")[0];
}
