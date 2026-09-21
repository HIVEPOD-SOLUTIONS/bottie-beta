import type { XrplWallet } from "@/lib/xrplBackend";

const INCOMING_TYPES = new Set(["ACTIVATION_DEPOSIT_DETECTED", "DEPOSIT_RECEIVED"]);
const OUTGOING_TYPES = new Set(["INTERNAL_TRANSFER_SENT", "RESERVE_RECOVERED"]);

/**
 * Reconstruct an XRP balance from bluvfi-xrpl's activity history.
 *
 * Only knows about what bluvfi-xrpl recorded: incoming payments, and
 * transfers/reserve recoveries it made itself. XRP sent out any other way
 * (e.g. someone signing directly with the wallet's seed) is invisible to
 * it, so this overstates the balance in that case. Prefer resolveXrpBalance,
 * which uses the live ledger balance when available and falls back to this.
 */
export function calculateXrpBalance(wallet: XrplWallet & { activities: unknown[] }): number {
  let drops = 0;

  for (const activity of wallet.activities ?? []) {
    const { type, amountDrops } = activity as { type?: string; amountDrops?: string | null };
    if (!amountDrops) continue;

    const amount = Number(amountDrops);
    if (!Number.isFinite(amount)) continue;
    if (INCOMING_TYPES.has(type ?? "")) drops += amount;
    else if (OUTGOING_TYPES.has(type ?? "")) drops -= amount;
  }

  return drops / 1_000_000;
}

/**
 * The wallet's current XRP balance — the account's full balance on the
 * ledger, reserve included (nothing is subtracted).
 *
 * Reads the live ledger balance bluvfi-xrpl returned when the wallet was
 * fetched with `{ includeLedgerBalance: true }`, so it reflects payments
 * made outside bluvfi-xrpl too. Falls back to the activity-log estimate when
 * that isn't available: the ledger couldn't be reached (null), or
 * bluvfi-xrpl predates the feature and didn't send the field at all.
 */
export function resolveXrpBalance(wallet: XrplWallet & { activities: unknown[] }): number {
  return typeof wallet.ledgerBalanceXrp === "number" ? wallet.ledgerBalanceXrp : calculateXrpBalance(wallet);
}

/**
 * Less than this above the reserve isn't worth showing or moving — it's the
 * dust left behind by network fees on a wallet that has effectively been
 * emptied (real wallets sit at e.g. 1.05001, not exactly 1.05).
 */
export const MIN_RECOVERABLE_XRP = 0.01;

/**
 * How much XRP in a failed/expired purchase wallet can actually be moved back
 * to the user: what the wallet HOLDS above the reserve + activation buffer it
 * has to keep — never what it was merely asked to receive.
 *
 * This replaces reading `swapAmountDrops` directly, which is the amount the
 * purchase *requested*, a fixed number that says nothing about whether any XRP
 * ever arrived. Using it, an abandoned never-funded attempt (which times out
 * as EXPIRED) told the user "the XRP you sent is safe" when nothing was ever
 * sent, and a wallet already recovered kept offering the same recovery.
 *
 * The locked portion is requiredActivationDrops − swapAmountDrops (~1.05 XRP:
 * the 1 XRP ledger reserve plus the 0.05 buffer). That is slightly more than
 * the reserve alone, so the amount returned is always safe to transfer —
 * bluvfi-xrpl refuses anything that would dig into the real reserve.
 *
 * Returns 0 when nothing worth recovering is there: never funded, already
 * recovered, or the numbers can't be trusted.
 *
 * The arithmetic is done in whole drops (integers): subtracting in XRP
 * floats (3.508365 − 1.05) lands a hair under the true value and would shave
 * a drop off the amount.
 */
export function recoverableXrpFromWallet(wallet: XrplWallet & { activities: unknown[] }): number {
  const required = Number(wallet.requiredActivationDrops);
  const swap = Number(wallet.swapAmountDrops ?? 0);
  if (!Number.isFinite(required) || !Number.isFinite(swap)) return 0;

  const balanceDrops = Math.round(resolveXrpBalance(wallet) * 1_000_000);
  const lockedDrops = required - swap;
  const spendableDrops = balanceDrops - lockedDrops;
  return spendableDrops >= MIN_RECOVERABLE_XRP * 1_000_000 ? spendableDrops / 1_000_000 : 0;
}
