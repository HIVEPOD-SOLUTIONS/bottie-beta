import { createHash } from "node:crypto";

/**
 * Rules for spotting one person behind several accounts. Pure functions, no database.
 *
 * Limits that count accounts alone are easy to get around by opening more accounts. So the app sends a stable id for the phone
 * (its Android ID), the server keeps only a one-way hash of it, and accounts that share a phone or a payout wallet are treated as
 * linked. Linked accounts don't earn from each other, a phone can only claim for a few accounts, and a payout to a linked
 * account needs a person to look at it first.
 */

export const ABUSE = {
  /** The device id header is ignored if it is shorter or longer than this. */
  minDeviceChars: 8,
  maxDeviceChars: 200,
  /** Devices remembered per account (the most recently used win). */
  maxDevicesPerAccount: 8,
  /** A phone where this many OTHER accounts have already claimed can't be used for another claim. */
  maxClaimingAccountsPerDevice: 2,
} as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A one-way hash of the device id the app sent, or null when it isn't usable. The raw id is never stored. */
export function deviceHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length < ABUSE.minDeviceChars || t.length > ABUSE.maxDeviceChars || CONTROL.test(t)) return null;
  return createHash("sha256").update(`bluvfi-device:${t}`).digest("hex");
}

export type RiskFlag = "shared_device" | "shared_wallet" | "linked_paid";

export interface RiskCounts {
  /** Other accounts that have used one of this account's phones. */
  otherAccountsOnDevice: number;
  /** Other accounts that asked for a payout to the same wallet (declined ones don't count). */
  otherAccountsOnWallet: number;
  /** Linked accounts (by phone or wallet) that have already been paid out. */
  linkedPaidAccounts: number;
}

/** Which red flags apply. Any flag means a person must acknowledge it before the payout is sent. */
export function riskFlags(c: RiskCounts): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (c.otherAccountsOnDevice > 0) flags.push("shared_device");
  if (c.otherAccountsOnWallet > 0) flags.push("shared_wallet");
  if (c.linkedPaidAccounts > 0) flags.push("linked_paid");
  return flags;
}

export interface RiskAssessment {
  flags: RiskFlag[];
  /** Notes that don't block a payout: "no_device" means we have never seen a phone for this account. */
  info: "no_device"[];
  /** How many other accounts are linked by phone or wallet. */
  linkedAccounts: number;
  /** False when the device table doesn't exist yet, so only the wallet check ran. */
  deviceChecks: boolean;
}

export const RISK_TEXT: Record<RiskFlag | "no_device", string> = {
  shared_device: "Another account has used the same phone.",
  shared_wallet: "Another account asked for a payout to this same wallet.",
  linked_paid: "A linked account has already been paid out.",
  no_device: "No phone on record for this account (an older app version, or checks weren't set up yet).",
};

/** Whether this many other claiming accounts on one phone is over the limit. */
export const overDeviceClaimLimit = (otherClaimingAccounts: number): boolean => otherClaimingAccounts >= ABUSE.maxClaimingAccountsPerDevice;
