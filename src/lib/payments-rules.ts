/**
 * Money rules for the open provider network and SKR payouts. Pure functions and constants, no database or network access.
 *
 * All money is whole micro-USDC (1 USDC = 1,000,000) or whole micro-SKR (SKR has 6 decimals), held as integers and written
 * out as decimal strings only for display. Floating point is never used for an amount that moves.
 *
 *  • Bluvfi is the merchant: callers pay Bluvfi, Bluvfi calls the provider, and the owner earns a commission.
 *  • Commission: the owner gets 80% of each paid call, Bluvfi keeps 20%.
 *  • Owners withdraw their commission as SKR. A person clicks every payout (nothing sends on its own).
 */

export const USDC_DECIMALS = 6;
export const SKR_DECIMALS = 6;
export const MICRO = 1_000_000;

/** SKR's mint on Solana mainnet (a plain SPL token with 6 decimals). */
export const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
/** USDC's mint on Solana mainnet. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const PAYMENTS = {
  /** The owner's share of each paid call, in basis points (8000 = 80%). Bluvfi keeps the rest. */
  ownerBps: 8000,
  /** The smallest commission balance an owner can withdraw ($5), so payouts are worth sending. */
  minWithdrawMicro: 5 * MICRO,
  /** The smallest top-up that is credited ($1): dust deposits aren't worth the bookkeeping. */
  minTopupMicro: 1 * MICRO,
  /** Largest price a provider may ask per call ($5). Mirrors NETWORK.maxPriceUsdc. */
  maxPriceMicro: 5 * MICRO,
  /** A single SKR payout above this is refused, so one mistaken click can't empty the treasury (SKR, whole units). */
  maxPayoutSkr: 25_000,
  /** SKR paid out in any rolling 24 hours above this is refused (whole units). */
  dailyPayoutCapSkr: 100_000,
  /** The treasury must keep at least this much SOL (lamports) for fees and new token accounts. */
  minTreasurySol: 10_000_000, // 0.01 SOL
  /** When the SKR price moves by more than this between the admin's review and the click, the payout is refused. */
  maxQuoteDriftBps: 300, // 3%
  /** A payout stuck "processing" with no transaction this long is released back to the queue. */
  processingStaleMs: 2 * 60_000,
} as const;

// ── Amounts ───────────────────────────────────────────────────────────────────

const DECIMAL = /^\d+(\.\d{1,6})?$/;

/** "0.05" to 50000. Null for anything that isn't a plain non-negative decimal with at most 6 places. */
export function usdToMicro(text: string): number | null {
  if (typeof text !== "string" || !DECIMAL.test(text.trim())) return null;
  const [whole, frac = ""] = text.trim().split(".");
  const micro = Number(whole) * MICRO + Number(frac.padEnd(6, "0"));
  return Number.isSafeInteger(micro) ? micro : null;
}

/** 50000 to "0.05": a trimmed decimal string, never exponent notation. */
export function microToDecimal(micro: number | bigint): string {
  const n = typeof micro === "bigint" ? micro : BigInt(Math.trunc(Number(micro)));
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** SKR decimal string ("1114.2") to micro-SKR. Same parsing rules as usdToMicro. */
export const skrToMicro = usdToMicro;

/**
 * The split of one paid call. The owner's part is rounded down; Bluvfi gets the remainder, so the two always add up to the
 * price exactly and no micro-USDC is ever created or lost.
 */
export function splitPrice(priceMicro: number): { owner: number; platform: number } {
  if (!Number.isSafeInteger(priceMicro) || priceMicro < 0) return { owner: 0, platform: 0 };
  const owner = Math.floor((priceMicro * PAYMENTS.ownerBps) / 10_000);
  return { owner, platform: priceMicro - owner };
}

/** Whether a price is one a listing may charge: a whole number of micro-USDC, from free up to the cap. */
export const isValidPriceMicro = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= PAYMENTS.maxPriceMicro;

// ── SKR for a USD amount ──────────────────────────────────────────────────────

/** How far apart two SKR amounts are, in basis points of the first. */
export function driftBps(expectedMicro: number, actualMicro: number): number {
  if (!(expectedMicro > 0)) return Infinity;
  return Math.round((Math.abs(actualMicro - expectedMicro) * 10_000) / expectedMicro);
}

/** USD per SKR as a 6-place decimal string, from what a quote says a USDC amount buys. */
export function usdPerSkr(usdMicro: number, skrMicro: number): string {
  if (!(skrMicro > 0)) return "0";
  // micro-USD per whole SKR, rounded to the nearest (not truncated), so the recorded price matches the one that was quoted.
  const skr = BigInt(skrMicro);
  const scaled = (BigInt(usdMicro) * 1_000_000n + skr / 2n) / skr;
  return microToDecimal(scaled);
}

// ── Payout states ─────────────────────────────────────────────────────────────

/** A payout that is still in flight. A person can have only one of these at a time. */
export const OPEN_PAYOUT_STATUSES = ["requested", "processing", "sent"] as const;
export type PayoutStatus = (typeof OPEN_PAYOUT_STATUSES)[number] | "paid" | "rejected";
export type PayoutKind = "shar_claim" | "commission";
export const isPayoutKind = (v: unknown): v is PayoutKind => v === "shar_claim" || v === "commission";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Addresses that are valid on Solana but must never receive a payout. */
const NEVER_PAY = new Set([
  "11111111111111111111111111111111", // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Program
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo
  SKR_MINT,
  USDC_MINT,
]);
export const isPayableAddress = (s: unknown): s is string => typeof s === "string" && BASE58.test(s) && !NEVER_PAY.has(s);
