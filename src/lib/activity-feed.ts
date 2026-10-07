import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  ACTIVITY,
  claimEntry,
  creditEntry,
  encodeCursor,
  isoFromDb,
  newestFirst,
  withdrawalEntry,
  type ActivityItem,
  type ActivitySource,
  type Cursor,
} from "@/lib/activity-rules";
import { spendCte } from "@/lib/shar";

/**
 * The activity feed: everything that moved for one person, newest first, a page at a time.
 *
 * Each source (purchases, provider use, claims, credits, commission, withdrawals) is asked for its own newest page and the pages are
 * merged, so no source can crowd out another and a missing table (a migration not applied yet) only hides that source. A position
 * in the feed is the exact time of the last entry (to the microsecond, as text) plus its id, with ids compared byte for byte
 * (COLLATE "C") in the database and in the merge, so paging never skips or repeats an entry, even at identical times.
 */

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;
// Every row a query returns is kept (nothing is dropped after the database applied the page limit): a dropped row would make a page
// come back short and end the history early. So anything that must not show is filtered in the query itself.
const missing = (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string } };
  return /(relation|column) .* does not exist/i.test(`${e?.message} ${e?.cause?.message}`);
};
const short = (wallet: string) => (wallet.length > 12 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet);

type Row = ActivityItem & { atText: string };
const AT = (col: string) => sql.raw(`to_char(${col}, 'YYYY-MM-DD HH24:MI:SS.US')`);

/** "Older than the cursor": an earlier time, or the same time and a smaller id. */
function olderThan(timeCol: string, idExpr: string, c: Cursor | null) {
  if (!c) return sql``;
  const time = sql.raw(timeCol);
  const id = sql.raw(`(${idExpr}) collate "C"`);
  return sql`and (${time} < ${c.at}::timestamp or (${time} = ${c.at}::timestamp and ${id} < ${c.id} collate "C"))`;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass back as `cursor` to get the next page; null when this is the end. */
  nextCursor: string | null;
  /** False when some of the history couldn't be read because a migration hasn't been applied yet. */
  ready: boolean;
}

export async function getActivity(userId: string, opts: { source?: ActivitySource; limit?: number; cursor?: Cursor | null } = {}): Promise<ActivityPage> {
  const source = opts.source ?? "all";
  const limit = Math.min(Math.max(opts.limit ?? ACTIVITY.defaultLimit, 1), ACTIVITY.maxLimit);
  const c = opts.cursor ?? null;
  const n = limit + 1; // one extra from each source tells us whether there is more
  let ready = true;

  const guarded = async (run: () => Promise<Row[]>): Promise<Row[]> => {
    try {
      return await run();
    } catch (err) {
      if (!missing(err)) throw err;
      ready = false;
      return [];
    }
  };

  const shar = source === "all" || source === "shar";
  const credits = source === "all" || source === "credits";
  const commission = source === "all" || source === "commission";

  const lists = await Promise.all([
    // Purchases are derived from payments, so they work before any migration.
    shar
      ? guarded(async () =>
          rowsOf<{ id: string; title: string; shar: string; status: string; at_text: string }>(
            await db.execute(sql`
              with ${spendCte()}
              select ('p:' || id::text) as id, description as title, shar, status, ${AT("created_at")} as at_text
              from spend where user_id = ${userId} ${olderThan("created_at", "'p:' || id::text", c)}
              order by created_at desc, ('p:' || id::text) collate "C" desc limit ${n}`),
          ).map((r): Row => ({ id: r.id, source: "shar", kind: "purchase", title: r.title, subtitle: null, amount: num(r.shar), unit: "shar", state: r.status === "completed" ? "done" : "pending", at: isoFromDb(r.at_text), atText: r.at_text })),
        )
      : Promise.resolve([] as Row[]),
    shar
      ? guarded(async () =>
          rowsOf<{ id: string; name: string; shar: string; at_text: string }>(
            await db.execute(sql`
              select ('u:' || u.id::text) as id, l.name, u.shar, ${AT("u.created_at")} as at_text
              from provider_usage u join provider_listings l on l.id = u.listing_id
              where l.owner_user_id = ${userId} and u.shar > 0 ${olderThan("u.created_at", "'u:' || u.id::text", c)}
              order by u.created_at desc, ('u:' || u.id::text) collate "C" desc limit ${n}`),
          ).map((r): Row => ({ id: r.id, source: "shar", kind: "provider", title: `${r.name} was used`, subtitle: null, amount: num(r.shar), unit: "shar", state: "done", at: isoFromDb(r.at_text), atText: r.at_text })),
        )
      : Promise.resolve([] as Row[]),
    shar
      ? guarded(async () =>
          rowsOf<{ id: string; status: string; shar: string; skr_amount: string; at_text: string }>(
            await db.execute(sql`
              select ('c:' || id::text) as id, status, shar, skr_amount, ${AT("created_at")} as at_text
              from shar_claims where user_id = ${userId} ${olderThan("created_at", "'c:' || id::text", c)}
              order by created_at desc, ('c:' || id::text) collate "C" desc limit ${n}`),
          ).map((r): Row => {
            const e = claimEntry(r.status);
            return { id: r.id, source: "shar", kind: "claim", title: e.title, subtitle: `${r.skr_amount} SKR`, amount: r.status === "rejected" ? 0 : -num(r.shar), unit: "shar", state: e.state, at: isoFromDb(r.at_text), atText: r.at_text };
          }),
        )
      : Promise.resolve([] as Row[]),
    credits
      ? guarded(async () =>
          rowsOf<{ id: string; kind: string; amount_micro: string; listing: string | null; at_text: string }>(
            await db.execute(sql`
              select ('l:' || l.id::text) as id, l.kind, l.amount_micro, p.name as listing, ${AT("l.created_at")} as at_text
              from credit_ledger l left join provider_listings p on p.id = l.listing_id
              where l.user_id = ${userId} and l.kind in ('topup', 'call', 'refund') ${olderThan("l.created_at", "'l:' || l.id::text", c)}
              order by l.created_at desc, ('l:' || l.id::text) collate "C" desc limit ${n}`),
          ).flatMap((r): Row[] => {
            const e = creditEntry(r.kind, r.listing);
            return e ? [{ id: r.id, source: "credits", kind: e.kind, title: e.title, subtitle: null, amount: num(r.amount_micro), unit: "usd", state: "done", at: isoFromDb(r.at_text), atText: r.at_text }] : [];
          }),
        )
      : Promise.resolve([] as Row[]),
    commission
      ? guarded(async () =>
          rowsOf<{ id: string; name: string; owner_micro: string; at_text: string }>(
            await db.execute(sql`
              select ('e:' || u.id::text) as id, l.name, u.owner_micro, ${AT("u.created_at")} as at_text
              from provider_usage u join provider_listings l on l.id = u.listing_id
              where l.owner_user_id = ${userId} and u.paid_micro > 0 ${olderThan("u.created_at", "'e:' || u.id::text", c)}
              order by u.created_at desc, ('e:' || u.id::text) collate "C" desc limit ${n}`),
          ).map((r): Row => ({ id: r.id, source: "commission", kind: "earned", title: `${r.name} was used`, subtitle: "Your 80% commission", amount: num(r.owner_micro), unit: "usd", state: "done", at: isoFromDb(r.at_text), atText: r.at_text })),
        )
      : Promise.resolve([] as Row[]),
    commission
      ? guarded(async () =>
          rowsOf<{ id: string; status: string; usd_micro: string; wallet: string; at_text: string }>(
            await db.execute(sql`
              select ('w:' || id::text) as id, status, usd_micro, wallet, ${AT("created_at")} as at_text
              from commission_payouts where user_id = ${userId} ${olderThan("created_at", "'w:' || id::text", c)}
              order by created_at desc, ('w:' || id::text) collate "C" desc limit ${n}`),
          ).map((r): Row => {
            const e = withdrawalEntry(r.status);
            return { id: r.id, source: "commission", kind: "withdrawal", title: e.title, subtitle: `To ${short(r.wallet)}`, amount: -num(r.usd_micro), unit: "usd", state: e.state, at: isoFromDb(r.at_text), atText: r.at_text };
          }),
        )
      : Promise.resolve([] as Row[]),
  ]);

  const merged = lists.flat().sort(newestFirst);
  const page = merged.slice(0, limit);
  const last = page[page.length - 1];
  const items: ActivityItem[] = page.map(({ atText: _at, ...item }) => item);
  return { items, nextCursor: merged.length > limit && last ? encodeCursor({ at: last.atText, id: last.id }) : null, ready };
}
