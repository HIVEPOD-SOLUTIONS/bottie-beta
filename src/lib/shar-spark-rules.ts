/**
 * Daily Spark, Shar badges and the weekly prizes: the numbers and the pure rules, with no database access. Like shar-rules.ts, every
 * figure a person can see comes from here, so it can be read, tested and changed in one place.
 *
 *  • Once a day (UTC day) a person taps the Shar orb and collects a few Shar.
 *  • Collecting on consecutive days builds a streak. Longer streaks multiply the day's Shar, and every 7th day adds a bonus.
 *  • Verified Seeker Genesis Token holders get a further multiplier, on the day's Shar and on the bonus.
 *  • Missing a day starts the streak again from 1.
 *
 * Shar from sparks is real Shar: it counts toward rank, the weekly board and SKR claims. So the numbers below are a budget, not just
 * a game setting. The most one person can collect is maxSparkPerWeek(): 38 Shar a week, or 57 for a Seeker holder. Change the numbers with that in mind.
 */

export const SPARK = {
  /** Shar for a first-day spark. */
  baseShar: 2,
  /** Streak multipliers: the highest `from` the streak has reached applies. */
  streakTiers: [
    { from: 1, multiplier: 1 },
    { from: 3, multiplier: 1.5 },
    { from: 7, multiplier: 2 },
  ],
  /** Extra Shar on every 7th consecutive day (day 7, 14, 21 …). */
  weekBonusShar: 10,
  /** Extra multiplier for a verified Seeker Genesis Token holder. */
  seekerMultiplier: 1.5,
} as const;

/**
 * Weekly prizes: Shar awarded to the top places of last week's board, first place first. Set to 50, 30 and 20 (decided 2026-10-14); an
 * empty list turns prizes off, and nothing is promised or paid while it is. The prize is paid as Shar, which is then claimed as SKR
 * through the normal claim (1 Shar = 0.9 SKR, the team reviews each claim), so prizes ride on the same checks as every other payout.
 * The most it can cost in a week is the sum of this list: 100 Shar, which is 90 SKR. A change only affects weeks that haven't closed.
 */
export const WEEKLY_PRIZE_SHAR: readonly number[] = [50, 30, 20];
/**
 * The first week (its Monday, UTC) that can win a prize. Prizes were decided on 2026-10-14, so the week of Oct 12 is the first one anybody
 * played knowing about them; earlier weeks are never paid after the fact. Weeks closed before this date are skipped.
 */
export const WEEKLY_PRIZE_FROM_WEEK = "2026-10-12";
/** A place only wins its prize if the person earned at least this much Shar that week, so an empty or idle board pays nothing. */
export const WEEKLY_PRIZE_MIN_SHAR = 20;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: unknown): s is string => typeof s === "string" && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** The UTC day a moment falls in, as YYYY-MM-DD. Sparks reset at 00:00 UTC, the same moment the weekly board does on Mondays. */
export function sparkDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The day before a YYYY-MM-DD day. */
export function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** When the next spark can be collected: the coming 00:00 UTC. */
export function nextSparkAt(now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** The streak a person has right now. It survives until the end of the day after their last spark, then it is 0. */
export function liveStreak(last: { day: string; streak: number } | null, today: string): { streak: number; collectedToday: boolean } {
  if (!last) return { streak: 0, collectedToday: false };
  if (last.day === today) return { streak: last.streak, collectedToday: true };
  if (last.day === dayBefore(today)) return { streak: last.streak, collectedToday: false };
  return { streak: 0, collectedToday: false };
}

/** The streak that collecting today's spark makes. */
export function streakAfterCollecting(last: { day: string; streak: number } | null, today: string): number {
  const live = liveStreak(last, today);
  return live.collectedToday ? live.streak : live.streak + 1;
}

export function streakMultiplier(streak: number): number {
  let m = 1;
  for (const t of SPARK.streakTiers) if (streak >= t.from) m = t.multiplier;
  return m;
}

export interface SparkReward {
  /** Total Shar for the day, whole numbers only. */
  shar: number;
  /** Shar before the weekly bonus. */
  daily: number;
  bonus: number;
  multiplier: number;
  seeker: boolean;
}

/** What a spark on this streak day is worth. Whole Shar: the fraction from a 1.5 multiplier is dropped, never rounded up. */
export function sparkReward(streak: number, seeker: boolean): SparkReward {
  const day = Math.max(1, Math.floor(streak));
  const boost = seeker ? SPARK.seekerMultiplier : 1;
  const multiplier = streakMultiplier(day);
  const daily = Math.floor(SPARK.baseShar * multiplier * boost);
  const bonus = day % 7 === 0 ? Math.floor(SPARK.weekBonusShar * boost) : 0;
  return { shar: daily + bonus, daily, bonus, multiplier, seeker };
}

/** The most Shar one person can collect in a week once their streak is running (every day at the top multiplier, one bonus day). */
export function maxSparkPerWeek(seeker: boolean): number {
  let total = 0;
  for (let d = 1; d <= 7; d++) total += sparkReward(7 * 100 + d, seeker).shar;
  return total;
}

// ── Badges and quests ─────────────────────────────────────────────────────────

export interface BadgeFacts {
  sparks: number;
  bestStreak: number;
  purchases: number;
  referred: number;
  providersOwned: number;
  claims: number;
  seeker: boolean;
  inSquad: boolean;
}

export const BADGES = [
  { key: "first_spark", label: "First Spark", hint: "Collect your first Daily Spark", earned: (f: BadgeFacts) => f.sparks >= 1 },
  { key: "streak_7", label: "7-day streak", hint: "Collect a spark 7 days in a row", earned: (f: BadgeFacts) => f.bestStreak >= 7 },
  { key: "streak_30", label: "30-day streak", hint: "Collect a spark 30 days in a row", earned: (f: BadgeFacts) => f.bestStreak >= 30 },
  { key: "first_purchase", label: "First purchase", hint: "Buy a gift card, top-up or eSIM", earned: (f: BadgeFacts) => f.purchases >= 1 },
  { key: "first_companion", label: "Companion", hint: "Invite a friend who joins with your code", earned: (f: BadgeFacts) => f.referred >= 1 },
  { key: "first_provider", label: "Provider", hint: "Add a provider to the open network", earned: (f: BadgeFacts) => f.providersOwned >= 1 },
  { key: "first_claim", label: "First claim", hint: "Claim your Shar as SKR", earned: (f: BadgeFacts) => f.claims >= 1 },
  { key: "squad_member", label: "Squad", hint: "Join or start a squad", earned: (f: BadgeFacts) => f.inSquad },
  { key: "seeker_holder", label: "Seeker Genesis", hint: "Hold a Seeker Genesis Token in a wallet linked to your account", earned: (f: BadgeFacts) => f.seeker },
] as const;

export type BadgeKey = (typeof BADGES)[number]["key"];

/** Every badge with whether it is earned. Derived from what is already stored, so it can never drift from the facts. */
export function badgesFor(facts: BadgeFacts): { key: BadgeKey; label: string; hint: string; earned: boolean }[] {
  return BADGES.map((b) => ({ key: b.key, label: b.label, hint: b.hint, earned: b.earned(facts) }));
}
