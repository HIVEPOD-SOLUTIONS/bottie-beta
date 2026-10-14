/**
 * Squads: a small group of friends pooling toward a weekly Shar goal. The numbers and the pure rules, with no database access.
 *
 *  • A squad has up to SQUAD.maxMembers people; a person is in at most one squad.
 *  • The squad's week is the sum of its members' Shar earned this week (purchases, providers and Daily Sparks, the same Shar the weekly
 *    board counts). The goal grows with the squad.
 *  • Reaching the goal is recognition (a banner, a place on the squads board). It mints no Shar, so squads cost nothing to run.
 *  • Squads are shown to other people only by a generated name ("Squad 7K2P"). The name a squad gives itself is seen by its members only,
 *    so nothing a person types can reach strangers.
 */

export const SQUAD = {
  maxMembers: 10,
  /** The weekly goal is this much Shar per member, never below minGoal. */
  goalPerMember: 50,
  minGoal: 100,
  nameMin: 2,
  nameMax: 24,
  codeLength: 6,
  /** How many squads the board lists. */
  boardSize: 10,
} as const;

/** Letters and digits, no look-alikes (the same alphabet as referral codes). */
export const SQUAD_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const isSquadCode = (s: unknown): s is string =>
  typeof s === "string" && s.length === SQUAD.codeLength && [...s].every((c) => SQUAD_CODE_ALPHABET.includes(c));

/** The weekly goal for a squad of this size. */
export function squadGoal(members: number): number {
  return Math.max(SQUAD.minGoal, Math.max(0, Math.floor(members)) * SQUAD.goalPerMember);
}

export interface SquadProgress {
  goal: number;
  shar: number;
  /** 0 to 1, for a progress bar. */
  progress: number;
  reached: boolean;
  /** What is still needed (0 once reached). */
  remaining: number;
}

export function squadProgress(shar: number, members: number): SquadProgress {
  const goal = squadGoal(members);
  const have = Math.max(0, Math.floor(shar));
  return { goal, shar: have, progress: Math.min(1, have / goal), reached: have >= goal, remaining: Math.max(0, goal - have) };
}

// A name is for a group of friends, not for broadcasting: letters (any language), digits, spaces and a little punctuation. Links, emails
// and anything that looks like a handle are refused, so a squad can't be used to advertise or to point people somewhere.
const ALLOWED = /^[\p{L}\p{N} '.,!&-]+$/u;
const LINKISH = /(https?:|www\.|\.(com|net|org|io|xyz|app|co|me|ly)\b|@|t\.me|discord)/i;

/** The tidied name, or null when it isn't acceptable. */
export function cleanSquadName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length < SQUAD.nameMin || name.length > SQUAD.nameMax) return null;
  if (!ALLOWED.test(name) || LINKISH.test(name)) return null;
  return name;
}

/** A squad's public name, made from its id so it never contains anything a person typed. */
export async function squadHandle(id: string): Promise<string> {
  const data = new TextEncoder().encode(`shar-squad:${id}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = Array.from(digest.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `Squad ${hex}`;
}

/** The share text for an invite. The code is entered in the app (Daily Spark, Squad). */
export function squadInviteMessage(name: string, code: string): string {
  return `Join my Bluvfi squad "${name}" and pool Shar toward our weekly goal. In the app open Daily Spark, then Squad, and enter the code ${code}.`;
}
