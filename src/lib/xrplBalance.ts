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
