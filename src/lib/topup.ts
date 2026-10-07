import { getUserWalletAddresses } from "@/lib/auth";
import { creditTopup, getBalanceMicro, signatureOwner } from "@/lib/credits";
import { PAYMENTS, USDC_MINT } from "@/lib/payments-rules";
import { getServerEnv } from "@/lib/server-env";
import { rpcCall } from "@/lib/solana-server";

/**
 * Adding credits: the user sends USDC on Solana from their own wallet to Bluvfi's deposit address, then submits the
 * transaction signature. We prove on-chain that the money really arrived from THEIR wallet before crediting it, exactly once.
 *
 * Proof comes from the transaction's own USDC balance changes (per owner), not from reading its instructions: whatever route
 * the money took, the net change of the deposit address and of the user's wallets is what actually moved.
 */

type TokenBalance = { mint: string; owner?: string; uiTokenAmount: { amount: string } };
export interface ParsedTx {
  slot?: number;
  blockTime?: number | null;
  meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
}

/** Net USDC change per owner address, as signed whole micro-USDC. */
export function usdcDeltaByOwner(tx: ParsedTx, mint: string = USDC_MINT): Map<string, bigint> {
  const delta = new Map<string, bigint>();
  const add = (owner: string | undefined, amount: string, sign: 1n | -1n) => {
    if (!owner) return;
    delta.set(owner, (delta.get(owner) ?? 0n) + sign * BigInt(amount));
  };
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint === mint) add(b.owner, b.uiTokenAmount.amount, 1n);
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint === mint) add(b.owner, b.uiTokenAmount.amount, -1n);
  return delta;
}

export type DepositCheck =
  | { ok: true; amountMicro: number; from: string[] }
  | { ok: false; reason: "failed" | "no_deposit" | "not_from_you" };

/**
 * How much of this transaction is a deposit to `depositOwner` that came from one of `userWallets`.
 * Credit = the smaller of what the deposit address gained and what the user's wallets lost, so a transaction that also moved
 * other people's money can never credit more than the user themselves sent.
 */
export function verifyUsdcDeposit(tx: ParsedTx, opts: { depositOwner: string; userWallets: string[]; mint?: string }): DepositCheck {
  if (!tx.meta || tx.meta.err) return { ok: false, reason: "failed" };
  const delta = usdcDeltaByOwner(tx, opts.mint ?? USDC_MINT);
  const gained = delta.get(opts.depositOwner) ?? 0n;
  if (gained <= 0n) return { ok: false, reason: "no_deposit" };
  const mine = new Set(opts.userWallets);
  let sent = 0n;
  const from: string[] = [];
  for (const [owner, d] of delta) {
    if (mine.has(owner) && d < 0n) {
      sent += -d;
      from.push(owner);
    }
  }
  if (sent <= 0n) return { ok: false, reason: "not_from_you" };
  const credit = gained < sent ? gained : sent;
  if (credit > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "no_deposit" };
  return { ok: true, amountMicro: Number(credit), from };
}

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const MAX_AGE_SECONDS = 7 * 24 * 3600;

export interface TopupDeps {
  getTx: (signature: string) => Promise<ParsedTx | null>;
  getWallets: (userId: string) => Promise<string[]>;
  depositAddress: () => string | undefined;
  now?: () => number;
}

export type TopupResult =
  | { ok: true; credited: boolean; amountMicro: number; balanceMicro: number }
  | { ok: false; status: number; error: string };

export const realTopupDeps: TopupDeps = {
  getTx: (signature) => rpcCall<ParsedTx | null>("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]),
  getWallets: async (userId) => (await getUserWalletAddresses(userId)).solana,
  depositAddress: () => getServerEnv("CREDITS_DEPOSIT_ADDRESS"),
};

/** Verifies a deposit and credits it once. Safe to call repeatedly with the same signature. */
export async function topupFromSignature(userId: string, signature: unknown, deps: TopupDeps = realTopupDeps): Promise<TopupResult> {
  const depositOwner = deps.depositAddress();
  if (!depositOwner) return { ok: false, status: 503, error: "Adding credits isn't switched on yet." };
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return { ok: false, status: 400, error: "That doesn't look like a transaction signature." };

  let tx: ParsedTx | null;
  try {
    tx = await deps.getTx(signature);
  } catch {
    return { ok: false, status: 502, error: "Couldn't check that transaction right now. Try again in a moment." };
  }
  if (!tx) return { ok: false, status: 404, error: "We can't see that transaction yet. Give it a few seconds and try again." };

  const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  if (tx.blockTime && nowSec - tx.blockTime > MAX_AGE_SECONDS) return { ok: false, status: 400, error: "That transaction is too old to credit." };

  let wallets: string[];
  try {
    wallets = await deps.getWallets(userId);
  } catch {
    return { ok: false, status: 502, error: "Couldn't check your wallets right now. Try again in a moment." };
  }

  const check = verifyUsdcDeposit(tx, { depositOwner, userWallets: wallets });
  if (!check.ok) {
    const error =
      check.reason === "failed" ? "That transaction failed on-chain, so nothing was sent."
      : check.reason === "no_deposit" ? "That transaction didn't send USDC to Bluvfi's deposit address."
      : "That deposit didn't come from one of your own wallets, so it can't be credited to you.";
    return { ok: false, status: 400, error };
  }
  if (check.amountMicro < PAYMENTS.minTopupMicro) return { ok: false, status: 400, error: `The smallest top-up is $${PAYMENTS.minTopupMicro / 1_000_000}.` };

  // A payment an outside agent made over x402 lands in the same wallet and its signature is public. It was already counted as
  // that call's revenue, so it can't also become someone's credits. (The claim inside creditTopup is the real guard; this is
  // for a clear message.)
  const owner = await signatureOwner(signature);
  if (owner === "x402") return { ok: false, status: 409, error: "That payment was used to pay for a provider call, so it can't be added as credits." };

  const res = await creditTopup(userId, signature, check.amountMicro);
  return { ok: true, credited: res.credited, amountMicro: check.amountMicro, balanceMicro: res.balanceMicro ?? (await getBalanceMicro(userId)) };
}
