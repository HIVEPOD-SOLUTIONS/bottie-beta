/**
 * Shar: Bluvfi's reward unit. Every number a person can see about Shar comes from this file, so the rules can be read, tested
 * and changed in one place. No database access here.
 *
 *  • Spend: 1 Shar per $1 on a completed purchase of $10 or more (gift cards, top-ups, eSIMs, investments).
 *  • Companion boost: a person's referrer earns 10% of the Shar that person earns from spending.
 *  • Providers: the owner of a verified provider earns Shar each time someone else uses it (capped, see provider-network.ts).
 *  • Claim: Shar can be taken out as SKR at a fixed rate (1 Shar = 0.9 SKR); a claim is paid by the team.
 *
 * The rates below are a first proposal, not a promise: change them here and everything (the API, the app's "How Shar works"
 * sheet, the claim maths) follows.
 */

export const SHAR = {
  /** Shar per dollar on a qualifying purchase. */
  perUsd: 1,
  /** Smaller purchases earn nothing, so a $1 top-up can't be farmed. */
  minPurchaseUsd: 10,
  /** Payment types that count as spending (banking moves and funding do not). */
  qualifyingTypes: ["bill", "investment"] as readonly string[],
  /** Share of a referred person's spending Shar that the referrer earns on top. */
  referralBonusRate: 0.1,
  /** Shar the owner of a verified provider earns per eligible use. */
  providerUseShar: 1,
  /** SKR paid per Shar when a claim is made (fixed, so the amount is known before claiming). */
  skrPerShar: 0.9,
  /** Smallest claim, to keep payouts worth sending. */
  minClaimShar: 1000,
  leaderboardSize: 10,
} as const;

/** Rank names from the story: Shar was the wisp that lit the way across the Boundary. */
export const TIERS = [
  { key: "spark", name: "Spark", from: 0 },
  { key: "wisp", name: "Wisp", from: 100 },
  { key: "guide", name: "Guide", from: 500 },
  { key: "seeker", name: "Seeker", from: 2000 },
] as const;

export type SharState = "available" | "pending" | "none";

const AMOUNT = /^[0-9]+(\.[0-9]+)?$/;

/** What one payment earns, and whether that Shar can be used yet. */
export function sharForPayment(p: { type: string; status: string; amountUsdc: string }): { shar: number; state: SharState } {
  if (!SHAR.qualifyingTypes.includes(p.type)) return { shar: 0, state: "none" };
  if (!AMOUNT.test(p.amountUsdc)) return { shar: 0, state: "none" };
  const usd = Number(p.amountUsdc);
  if (!(usd >= SHAR.minPurchaseUsd)) return { shar: 0, state: "none" };
  const shar = Math.floor(usd * SHAR.perUsd);
  if (p.status === "completed") return { shar, state: "available" };
  if (p.status === "pending" || p.status === "processing") return { shar, state: "pending" };
  return { shar: 0, state: "none" };
}

/** Where a lifetime total puts someone on the ladder, and how far to the next rung. */
export function tierFor(lifetime: number) {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) if (lifetime >= TIERS[i].from) idx = i;
  const tier = TIERS[idx];
  const next = TIERS[idx + 1] ?? null;
  const progress = next ? Math.min(1, Math.max(0, (lifetime - tier.from) / (next.from - tier.from))) : 1;
  return { tier: tier.key, name: tier.name, next: next ? { name: next.name, at: next.from } : null, progress };
}

/** Monday 00:00 UTC of the week containing `now`: when the weekly leaderboard last reset. */
export function weekStartUtc(now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sinceMonday = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - sinceMonday);
  return d;
}

/** When the current week's leaderboard resets next. */
export function nextWeekStartUtc(now: Date = new Date()): Date {
  const d = weekStartUtc(now);
  d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

/** Referral bonus for one referred person's spending Shar. */
export function referralBonus(refereeSpendingShar: number): number {
  return Math.floor(Math.max(0, refereeSpendingShar) * SHAR.referralBonusRate);
}

/** SKR for an amount of Shar, as a decimal string (no float noise). */
export function skrForShar(shar: number): string {
  // Whole micro-SKR throughout, so a fractional rate never picks up float noise (1234 * 0.9 is 1110.6000000000001 in floating point).
  const microPerShar = Math.round(SHAR.skrPerShar * 1_000_000);
  const total = (Number.isFinite(shar) ? Math.max(0, Math.floor(shar)) : 0) * microPerShar;
  const whole = Math.floor(total / 1_000_000);
  const frac = String(total % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isSolanaAddress = (s: unknown): s is string => typeof s === "string" && BASE58.test(s);

/** Referral codes avoid look-alike characters (no 0/O, 1/I/L). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const isReferralCode = (s: unknown): s is string =>
  typeof s === "string" && s.length === CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c));

/** A stable, non-identifying name for a person on the leaderboard (never an email or address). */
export async function handleFor(userId: string): Promise<string> {
  const data = new TextEncoder().encode(`shar-handle:${userId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = Array.from(digest.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `Seeker ${hex}`;
}
