import type { XrplWallet } from "@/lib/xrplBackend";

const INCOMING_TYPES = new Set(["ACTIVATION_DEPOSIT_DETECTED", "DEPOSIT_RECEIVED"]);
const OUTGOING_TYPES = new Set(["INTERNAL_TRANSFER_SENT", "RESERVE_RECOVERED"]);

/** Reconstruct the current XRP balance from bluvfi-xrpl's activity history. */
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
