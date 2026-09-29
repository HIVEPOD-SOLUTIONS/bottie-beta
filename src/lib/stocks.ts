import { randomInt, randomUUID } from "node:crypto";
import { and, eq, desc, inArray } from "drizzle-orm";
import { createPublicClient, http, parseAbiItem, decodeEventLog, type Hex } from "viem";
import { base } from "viem/chains";
import { db } from "@/lib/db";
import { stockOrders } from "@/lib/db/schema";
import { getServerEnv } from "@/lib/server-env";
import { getUserWalletAddresses } from "@/lib/auth";
import {
  listSecurities,
  listStockSpotMarkets,
  stockPrices,
  currentSession,
  submitRfq,
  getRfqHistory,
  getRfqFills,
  executeSpotOrder,
  depositAddress,
  withdrawUsdc,
  spotSymbol,
  rfqSymbol,
  BackpackError,
  type Security,
} from "@/lib/backpack";
import { CASH, credit, debit } from "@/lib/stocks-ledger";

/**
 * Stock trading for Bluvfi users on Bluvfi's single Backpack account.
 *
 * Money in:  user sends USDC on Base to Bluvfi's Backpack deposit address;
 *            verifyDeposit() checks the tx on-chain (from one of the user's own
 *            wallets, to our address) and credits their stock cash once.
 * Trading:   placeTrade() reserves cash (buy) or shares (sell) in the ledger,
 *            then sends an RFQ (market hours) or an IOC spot order (off-hours,
 *            the few stocks with an order book) with a price cap.
 *            syncOrder() settles fills into the ledger and releases whatever
 *            wasn't used — idempotently, so it can be called any number of times.
 * Money out: requestWithdrawal() debits cash and asks Backpack to send USDC to
 *            the user's wallet on Base.
 */

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export class StocksError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "StocksError";
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

function numEnv(name: string, fallback: number): number {
  const v = Number(getServerEnv(name));
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
/** Worst price we'll accept vs the fair-market price (default 1%). */
const slippage = () => numEnv("STOCKS_SLIPPAGE_BPS", 100) / 10_000;
/** Bluvfi fee on each trade (default 0.3%) — also covers exchange fees on the shared account. */
const feeRate = () => numEnv("STOCKS_FEE_BPS", 30) / 10_000;
const maxTradeUsd = () => numEnv("STOCKS_MAX_TRADE_USD", 1000);
const minTradeUsd = () => numEnv("STOCKS_MIN_TRADE_USD", 1);

// Decimal strings for the ledger; 6 dp is USDC precision, shares use the session step.
const usdc = (n: number) => (Math.floor(n * 1e6) / 1e6).toFixed(6);
const usdcUp = (n: number) => (Math.ceil(n * 1e6) / 1e6).toFixed(6);

function decimals(step: string): number {
  const i = step.indexOf(".");
  return i < 0 ? 0 : step.length - i - 1;
}

// ── Quotes ───────────────────────────────────────────────────────────────────

export interface TradeQuote {
  asset: string;
  name: string;
  side: "buy" | "sell";
  quantity: string;
  venue: "rfq" | "spot";
  session: string | null;
  marketPrice: number;
  limitPrice: string;
  /** Buy: max USDC reserved (qty × limit + fee). Sell: min USDC you'll receive. */
  estimateUsdc: string;
  feeUsdc: string;
}

async function findSecurity(asset: string): Promise<Security> {
  const sec = (await listSecurities()).find((s) => s.asset === asset);
  if (!sec) throw new StocksError(`${asset} isn't available to trade.`, 404);
  return sec;
}

/** Validates a trade against market hours and size rules and prices it. Nothing is reserved or sent. */
export async function quoteTrade(asset: string, side: "buy" | "sell", quantityIn: string): Promise<TradeQuote> {
  const sec = await findSecurity(asset);
  const session = await currentSession();

  let venue: "rfq" | "spot";
  let rules = session ? sec.sessions.find((s) => s.name === session.name) : undefined;
  if (session && rules) venue = "rfq";
  else if ((await listStockSpotMarkets()).includes(spotSymbol(asset))) {
    venue = "spot";
    rules = sec.sessions.find((s) => s.name === "US_EQUITIES_REGULAR") ?? sec.sessions[0];
  } else {
    throw new StocksError(session
      ? `${asset} doesn't trade in the ${session.description ?? session.name} session. Try during regular hours (9:30 AM–4:00 PM ET).`
      : "The US stock market is closed right now. Trading reopens Sunday 8 PM ET (overnight session).", 409);
  }

  const qty = Number(quantityIn);
  const step = Number(rules!.stepSize);
  if (!(qty > 0)) throw new StocksError("Enter how many shares.");
  const snapped = Math.floor(qty / step + 1e-9) * step;
  const quantity = snapped.toFixed(decimals(rules!.stepSize));
  if (Number(quantity) < Number(rules!.minQuantity)) throw new StocksError(`The minimum right now is ${rules!.minQuantity} share(s) of ${asset}.`);
  if (Number(quantity) > Number(rules!.maxQuantity)) throw new StocksError(`The maximum right now is ${rules!.maxQuantity} shares of ${asset}.`);

  const ticker = (await stockPrices()).get(asset);
  const marketPrice = Number(ticker?.lastPrice);
  if (!(marketPrice > 0)) throw new StocksError(`No live price for ${asset} right now. Try again shortly.`, 503);

  const limit = side === "buy" ? marketPrice * (1 + slippage()) : marketPrice * (1 - slippage());
  const limitPrice = limit.toFixed(marketPrice >= 1 ? 2 : 4);
  const gross = Number(quantity) * Number(limitPrice);
  const fee = gross * feeRate();
  const notional = Number(quantity) * marketPrice;
  if (notional > maxTradeUsd()) throw new StocksError(`Trades are limited to $${maxTradeUsd()} for now.`);
  if (notional < minTradeUsd()) throw new StocksError(`The minimum trade is $${minTradeUsd()}.`);

  return {
    asset,
    name: sec.name,
    side,
    quantity,
    venue,
    session: session?.name ?? null,
    marketPrice,
    limitPrice,
    estimateUsdc: side === "buy" ? usdcUp(gross + fee) : usdc(gross - fee),
    feeUsdc: usdcUp(fee),
  };
}

// ── Trading ──────────────────────────────────────────────────────────────────

export type StockOrder = typeof stockOrders.$inferSelect;

/**
 * Reserves funds and sends the order to Backpack. Returns the order row;
 * settlement happens in syncOrder(). Throws StocksError for anything the
 * user can fix (balance, size, hours).
 */
export async function placeTrade(userId: string, asset: string, side: "buy" | "sell", quantityIn: string, maxLimitPrice?: number): Promise<StockOrder> {
  const q = await quoteTrade(asset, side, quantityIn);
  // Don't trade at a worse cap than the user confirmed on screen.
  if (maxLimitPrice !== undefined && (side === "buy" ? Number(q.limitPrice) > maxLimitPrice * 1.005 : Number(q.limitPrice) < maxLimitPrice * 0.995)) {
    throw new StocksError("The price moved since you checked. Review the new price and try again.", 409);
  }

  const [order] = await db.insert(stockOrders).values({
    userId,
    venue: q.venue,
    symbol: q.venue === "rfq" ? rfqSymbol(asset) : spotSymbol(asset),
    asset,
    side,
    quantity: q.quantity,
    limitPrice: q.limitPrice,
    reservedUsdc: side === "buy" ? q.estimateUsdc : "0",
  }).returning();

  // Reserve before anything leaves the building.
  const reserved = side === "buy"
    ? await debit(userId, CASH, q.estimateUsdc, "reserve", order.id, `buy ${q.quantity} ${asset}`)
    : await debit(userId, asset, q.quantity, "reserve", order.id, `sell ${q.quantity} ${asset}`);
  if (!reserved) {
    await db.update(stockOrders).set({ status: "failed", error: "insufficient balance", updatedAt: new Date() }).where(eq(stockOrders.id, order.id));
    throw new StocksError(side === "buy"
      ? `You need $${q.estimateUsdc} of stock cash for this buy. Add USDC first.`
      : `You don't have ${q.quantity} ${asset} to sell.`);
  }

  const clientId = randomInt(1, 2 ** 31 - 1);
  try {
    if (q.venue === "rfq") {
      const rfq = await submitRfq({ asset, side: side === "buy" ? "Bid" : "Ask", quantity: q.quantity, price: q.limitPrice, clientId });
      await db.update(stockOrders).set({ externalId: rfq.rfqId, updatedAt: new Date() }).where(eq(stockOrders.id, order.id));
    } else {
      const o = await executeSpotOrder({ asset, side: side === "buy" ? "Bid" : "Ask", quantity: q.quantity, limitPrice: q.limitPrice, clientId });
      await db.update(stockOrders).set({ externalId: String(o.id), updatedAt: new Date() }).where(eq(stockOrders.id, order.id));
      // IOC orders are final as soon as they return.
      await settle(order.id, Number(o.executedQuantity ?? 0), Number(o.executedQuoteQuantity ?? 0), o.status);
    }
  } catch (err) {
    await release(order, `rejected: ${err instanceof Error ? err.message : err}`);
    throw err instanceof BackpackError
      ? new StocksError(`The exchange rejected the order: ${err.message}`, 502)
      : err;
  }
  return (await getOrderRow(order.id))!;
}

async function getOrderRow(id: string) {
  const [row] = await db.select().from(stockOrders).where(eq(stockOrders.id, id)).limit(1);
  return row;
}

/** Returns reserved funds untouched by a fill and closes the order. */
async function release(order: StockOrder, reason: string, status: "cancelled" | "expired" | "failed" = "failed") {
  if (order.side === "buy") await credit(order.userId, CASH, order.reservedUsdc, "release", order.id, reason);
  else await credit(order.userId, order.asset, order.quantity, "release", order.id, reason);
  await db.update(stockOrders)
    .set({ status, error: reason.slice(0, 300), updatedAt: new Date() })
    .where(and(eq(stockOrders.id, order.id), eq(stockOrders.status, "pending")));
}

/**
 * Books a (possibly partial) fill. Buy: shares in, unused reserve back.
 * Sell: USDC proceeds in (minus fee), unsold shares back. Every ledger write
 * is keyed on the order id, so re-running this is harmless.
 */
async function settle(orderId: string, fillQty: number, fillQuote: number, venueStatus: string) {
  const order = await getOrderRow(orderId);
  if (!order || order.status !== "pending") return;

  if (!(fillQty > 0)) {
    await release(order, `no fill (${venueStatus})`, venueStatus === "Expired" ? "expired" : "cancelled");
    return;
  }

  const qtyStr = fillQty.toFixed(12).replace(/\.?0+$/, "");
  const fee = fillQuote * feeRate();
  if (order.side === "buy") {
    const cost = fillQuote + fee;
    await credit(order.userId, order.asset, qtyStr, "buy", order.id, `@ ${(fillQuote / fillQty).toFixed(4)}`);
    const refund = Number(order.reservedUsdc) - cost;
    if (refund > 0.000001) await credit(order.userId, CASH, usdc(refund), "release", order.id, "unused reserve");
  } else {
    const proceeds = usdc(fillQuote - fee);
    await credit(order.userId, CASH, proceeds, "sell", order.id, `${qtyStr} @ ${(fillQuote / fillQty).toFixed(4)}`);
    const unsold = Number(order.quantity) - fillQty;
    if (unsold > 1e-9) await credit(order.userId, order.asset, unsold.toFixed(12).replace(/\.?0+$/, ""), "release", order.id, "unsold");
    // Sale money goes straight back to the user's wallet. Under $1 (Backpack's
    // minimum) or if the send fails, it stays as credit for their next buy.
    if (Number(proceeds) >= 1) {
      await requestWithdrawal(order.userId, proceeds, order.id).catch((err) =>
        console.warn(`[stocks] proceeds of ${order.id} kept as credit:`, err instanceof Error ? err.message : err));
    }
  }
  await db.update(stockOrders).set({
    status: "filled",
    fillQuantity: qtyStr,
    fillQuoteQuantity: fillQuote.toFixed(6),
    fillPrice: (fillQuote / fillQty).toFixed(6),
    updatedAt: new Date(),
  }).where(and(eq(stockOrders.id, order.id), eq(stockOrders.status, "pending")));
}

/**
 * Brings a pending RFQ order up to date with Backpack. Deferred settlement
 * means an accepted RFQ can take a little while to fill — until then it stays
 * pending with the reserve held.
 */
export async function syncOrder(order: StockOrder): Promise<StockOrder> {
  if (order.status !== "pending" || order.venue !== "rfq") return order;
  if (!order.externalId) {
    // Submission never reached Backpack (crash mid-request). Release after a grace period.
    if (Date.now() - new Date(order.createdAt).getTime() > 5 * 60_000) await release(order, "never submitted");
    return (await getOrderRow(order.id))!;
  }
  const [rfq] = await getRfqHistory(order.externalId).catch(() => []);
  if (!rfq) return order; // still open / not in history yet
  if (rfq.status === "Filled" || rfq.status === "PartiallyFilled" || Number(rfq.executedQuantity ?? 0) > 0) {
    const fills = await getRfqFills(order.externalId);
    const qty = fills.reduce((s, f) => s + Number(f.fillQuantity ?? 0), 0);
    const quote = fills.reduce((s, f) => s + (f.fillQuoteQuantity !== undefined ? Number(f.fillQuoteQuantity) : Number(f.fillQuantity ?? 0) * Number(f.fillPrice)), 0);
    if (qty > 0) await settle(order.id, qty, quote, rfq.status);
    else if (rfq.status === "Filled") return order; // fill rows not visible yet; next sync books them
  } else if (rfq.status === "Expired" || rfq.status === "Cancelled") {
    await settle(order.id, 0, 0, rfq.status);
  }
  return (await getOrderRow(order.id))!;
}

export async function listOrders(userId: string, limit = 20): Promise<StockOrder[]> {
  const rows = await db.select().from(stockOrders).where(eq(stockOrders.userId, userId)).orderBy(desc(stockOrders.createdAt)).limit(limit);
  const pending = rows.filter((r) => r.status === "pending");
  if (!pending.length) return rows;
  await Promise.all(pending.map((r) => syncOrder(r).catch(() => r)));
  return db.select().from(stockOrders).where(and(eq(stockOrders.userId, userId), inArray(stockOrders.id, rows.map((r) => r.id)))).orderBy(desc(stockOrders.createdAt));
}

export async function getOrderForUser(userId: string, id: string): Promise<StockOrder | null> {
  const [row] = await db.select().from(stockOrders).where(and(eq(stockOrders.id, id), eq(stockOrders.userId, userId))).limit(1);
  return row ? syncOrder(row) : null;
}

// ── Deposits ─────────────────────────────────────────────────────────────────

export async function depositInstructions(): Promise<{ address: string; chain: "Base"; token: "USDC"; contract: string }> {
  const { address } = await depositAddress("Base");
  return { address, chain: "Base", token: "USDC", contract: BASE_USDC };
}

/**
 * Credits a USDC-on-Base transfer to Bluvfi's Backpack deposit address, once,
 * if it came from one of the user's own wallets.
 */
export async function verifyDeposit(userId: string, txHash: string): Promise<{ credited: boolean; amount: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new StocksError("That isn't a Base transaction hash.");
  const [{ address }, wallets] = await Promise.all([depositAddress("Base"), getUserWalletAddresses(userId)]);
  const client = createPublicClient({ chain: base, transport: http(`https://base-mainnet.g.alchemy.com/v2/${getServerEnv("NEXT_PUBLIC_ALCHEMY_API_KEY")}`) });

  const receipt = await client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
  if (!receipt) throw new StocksError("Transaction not found yet. Wait a few seconds and try again.", 404);
  if (receipt.status !== "success") throw new StocksError("That transaction failed on-chain.");

  let total = BigInt(0);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== BASE_USDC.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
      if (ev.args.to.toLowerCase() === address.toLowerCase() && wallets.evm.includes(ev.args.from.toLowerCase())) total += ev.args.value;
    } catch { /* not a Transfer */ }
  }
  if (total === BigInt(0)) throw new StocksError("No USDC from your wallet to the Bluvfi stocks address in that transaction.");

  const amount = (Number(total) / 1e6).toFixed(6);
  const credited = await credit(userId, CASH, amount, "deposit", txHash.toLowerCase(), "USDC on Base");
  return { credited, amount };
}

// ── Withdrawals ──────────────────────────────────────────────────────────────

export interface WithdrawalResult { id: string; amount: string; status: "sent" | "queued"; to: string }

/**
 * Sends stock cash back to the user's Bluvfi wallet (USDC on Base). If
 * Backpack needs 2FA for the address (it isn't in the account's 2FA-exempt
 * address book), the request stays debited and is queued for the Bluvfi team
 * to send manually — never silently dropped.
 */
export async function requestWithdrawal(userId: string, amountIn: string, ref?: string): Promise<WithdrawalResult> {
  const amount = Number(amountIn);
  if (!(amount >= 1)) throw new StocksError("The minimum withdrawal is $1.");
  const { evm } = await getUserWalletAddresses(userId);
  const to = evm[0];
  if (!to) throw new StocksError("No wallet found for your account.");

  // A fixed ref (e.g. a sell order id) makes the payout idempotent: the ledger's
  // unique (kind, ref, asset) means it can only ever be debited once.
  const id = ref ?? randomUUID();
  const amt = usdc(amount);
  if (!(await debit(userId, CASH, amt, "withdraw", id, JSON.stringify({ to, status: "requested" })))) {
    throw new StocksError("You don't have that much stock cash.");
  }
  try {
    await withdrawUsdc({ address: to, blockchain: "Base", quantity: amt, clientId: id });
    return { id, amount: amt, status: "sent", to };
  } catch (err) {
    if (err instanceof BackpackError && /2FA|TWO_FACTOR/i.test(`${err.code} ${err.message}`)) {
      console.warn(`[stocks] withdrawal ${id} queued for manual processing: ${amt} USDC → ${to}`);
      return { id, amount: amt, status: "queued", to };
    }
    await credit(userId, CASH, amt, "withdraw_refund", id, err instanceof Error ? err.message.slice(0, 200) : "failed");
    throw new StocksError("The withdrawal couldn't be sent. Your balance was restored. Try again later.", 502);
  }
}
