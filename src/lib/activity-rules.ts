/**
 * The shape of the activity feed and the small rules around it: which sources exist, how a page is requested, how a position in
 * the feed (a cursor) is written, and the wording and state of each kind of entry. No database access here.
 *
 * The feed is one history across everything that moves for a person: Shar (purchases, provider use, claims), credits (top-ups, paid
 * calls, refunds) and commission (what their providers earned, and withdrawals). Amounts are whole numbers: Shar as itself, money
 * as micro-USDC.
 */

export const SOURCES = ["all", "shar", "credits", "commission"] as const;
export type ActivitySource = (typeof SOURCES)[number];

export const ACTIVITY = { defaultLimit: 25, maxLimit: 50 } as const;

export type ActivityKind = "purchase" | "provider" | "claim" | "topup" | "call" | "refund" | "earned" | "withdrawal";
/** done: settled. pending: counted but not final yet. review: waiting for the team. sending: on its way. rejected: declined. */
export type ActivityState = "done" | "pending" | "review" | "sending" | "rejected";

export interface ActivityItem {
  id: string;
  source: Exclude<ActivitySource, "all">;
  kind: ActivityKind;
  title: string;
  subtitle: string | null;
  /** Signed. Shar, or micro-USDC when `unit` is "usd". */
  amount: number;
  unit: "shar" | "usd";
  state: ActivityState;
  at: string;
}

export const parseSource = (raw: unknown): ActivitySource => (SOURCES.includes(raw as ActivitySource) ? (raw as ActivitySource) : "all");

/** A page size from the query string: a whole number between 1 and the maximum, otherwise the default. */
export function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return ACTIVITY.defaultLimit;
  return Math.min(n, ACTIVITY.maxLimit);
}

/** A position in the feed: the exact time of the last entry seen (to the microsecond) and its id. */
export interface Cursor {
  /** "YYYY-MM-DD HH:MM:SS.ffffff", the database's own text for the time. */
  at: string;
  id: string;
}

const AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

export const encodeCursor = (c: Cursor): string => `${c.at}|${c.id}`;

export function parseCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string" || raw.length > 120) return null;
  const i = raw.indexOf("|");
  if (i < 0) return null;
  const at = raw.slice(0, i);
  const id = raw.slice(i + 1);
  return AT.test(at) && id.length > 0 && !/[\u0000-\u001f]/.test(id) ? { at, id } : null; // eslint-disable-line no-control-regex
}

/** The database's fixed-width timestamp text as an ISO time (the database runs on UTC). */
export const isoFromDb = (at: string): string => `${at.slice(0, 10)}T${at.slice(11, 23)}Z`;

// ── wording ──────────────────────────────────────────────────────────────────

/** A Shar claim's title and state from its status. */
export function claimEntry(status: string): { title: string; state: ActivityState } {
  switch (status) {
    case "paid": return { title: "Claimed as SKR", state: "done" };
    case "rejected": return { title: "Claim declined", state: "rejected" };
    case "processing":
    case "sent": return { title: "SKR on its way", state: "sending" };
    default: return { title: "SKR claim requested", state: "review" };
  }
}

/** A commission withdrawal's title and state from its status. */
export function withdrawalEntry(status: string): { title: string; state: ActivityState } {
  switch (status) {
    case "paid": return { title: "Withdrawn as SKR", state: "done" };
    case "rejected": return { title: "Withdrawal declined", state: "rejected" };
    case "processing":
    case "sent": return { title: "Withdrawal on its way", state: "sending" };
    default: return { title: "Withdrawal requested", state: "review" };
  }
}

/** A credits entry's title: what the money was for. */
export function creditEntry(kind: string, listing: string | null): { kind: ActivityKind; title: string } | null {
  if (kind === "topup") return { kind: "topup", title: "Added credits" };
  if (kind === "call") return { kind: "call", title: listing ? `Used ${listing}` : "Used a provider" };
  if (kind === "refund") return { kind: "refund", title: listing ? `Refund: ${listing}` : "Refund" };
  return null;
}

/** Entries from several sources, newest first, ties broken the same way the database orders them (by id, byte for byte). */
export function newestFirst<T extends { atText: string; id: string }>(a: T, b: T): number {
  if (a.atText !== b.atText) return a.atText < b.atText ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
