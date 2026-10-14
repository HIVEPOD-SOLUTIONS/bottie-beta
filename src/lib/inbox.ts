import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * Notifications with no push service and no account to set up anywhere. The server leaves short messages in an inbox
 * (notification_inbox, drizzle/0018); the app asks for what is new, in the background about every 15 minutes at best (Android decides
 * when) and whenever it opens, and shows each one as a notification on the phone.
 *
 *  • Only people who turned alerts on are written to: a message is stored only if they have a key.
 *  • A message is a title, a short line and a screen to open. Never an amount, wallet or address.
 *  • A phone reads its inbox with a secret key made when alerts are turned on. Only a one-way hash is kept; the key reads that person's
 *    notification text and nothing else, and it is revoked when they turn alerts off.
 *  • The trade-off against a push service: it is not instant. A message shows up the next time the phone checks.
 */

export const INBOX = {
  maxKeysPerUser: 5,
  /** Most messages handed over in one check. */
  page: 20,
  /** A message is only offered for this long: an old alert is not worth showing. */
  offerDays: 7,
  /** And only kept this long. */
  keepDays: 30,
  /** The key is "bvi_" plus 32 random bytes, base64url. */
  keyPattern: /^bvi_[A-Za-z0-9_-]{43}$/,
} as const;

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;
const missing = (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string } };
  return /(relation|column) .* does not exist/i.test(`${e?.message} ${e?.cause?.message}`);
};
const SETUP = { ok: false as const, status: 503, error: "Alerts are being set up. Try again soon." };

export const hashInboxKey = (key: string) => createHash("sha256").update(`bluvfi-inbox:${key}`).digest("hex");
export const isInboxKey = (k: unknown): k is string => typeof k === "string" && INBOX.keyPattern.test(k);

export interface InboxMessage {
  title: string;
  body: string;
  /** A bluvfi:// link the app opens when the notification is tapped. */
  url?: string;
}

export interface InboxItem extends Required<Pick<InboxMessage, "title" | "body">> {
  id: number;
  url: string | null;
  at: string;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

/**
 * Turns alerts on for one phone: makes its secret key and returns it once (only the hash is stored). The cursor is where the inbox is now,
 * so the phone only ever shows what happens from here on. An account keeps its newest few phones.
 */
export async function createInboxKey(userId: string): Promise<{ ok: true; key: string; cursor: number } | typeof SETUP> {
  const key = `bvi_${randomBytes(32).toString("base64url")}`;
  try {
    await db.execute(sql`insert into inbox_keys (key_hash, user_id) values (${hashInboxKey(key)}, ${userId})`);
    await db.execute(sql`
      delete from inbox_keys where user_id = ${userId} and key_hash in (
        select key_hash from inbox_keys where user_id = ${userId} order by created_at desc offset ${INBOX.maxKeysPerUser})`);
    await db.execute(sql`delete from notification_inbox where created_at < now() - make_interval(days => ${INBOX.keepDays})`);
    const cursor = num(rowsOf<{ n: string }>(await db.execute(sql`select coalesce(max(id), 0) as n from notification_inbox where user_id = ${userId}`))[0]?.n);
    return { ok: true, key, cursor };
  } catch (err) {
    if (missing(err)) return SETUP;
    throw err;
  }
}

/** Turns alerts off for a phone, but only if the key is this account's (nobody can switch off someone else's). */
export async function revokeInboxKey(userId: string, key: unknown): Promise<void> {
  if (!isInboxKey(key)) return;
  try {
    await db.execute(sql`delete from inbox_keys where key_hash = ${hashInboxKey(key)} and user_id = ${userId}`);
  } catch (err) {
    if (!missing(err)) throw err;
  }
}

/** Reads what is new for the person this key belongs to, oldest first, after the cursor the phone last saw. */
export async function readInbox(key: unknown, after: unknown): Promise<{ ok: true; items: InboxItem[]; cursor: number; userId: string } | { ok: false; status: number; error: string }> {
  if (!isInboxKey(key)) return { ok: false, status: 401, error: "Invalid key." };
  const from = Math.max(0, Math.floor(num(after)));
  try {
    const owner = rowsOf<{ user_id: string }>(
      await db.execute(sql`update inbox_keys set last_used_at = now() where key_hash = ${hashInboxKey(key)} returning user_id`),
    )[0]?.user_id;
    if (!owner) return { ok: false, status: 401, error: "Invalid key." };
    const rows = rowsOf<{ id: string; title: string; body: string; url: string | null; created_at: string }>(
      await db.execute(sql`
        select id, title, body, url, created_at from notification_inbox
        where user_id = ${owner} and id > ${from} and created_at > now() - make_interval(days => ${INBOX.offerDays})
        order by id asc limit ${INBOX.page}`),
    );
    const items = rows.map((r): InboxItem => ({ id: num(r.id), title: r.title, body: r.body, url: r.url, at: new Date(r.created_at).toISOString() }));
    return { ok: true, items, cursor: items.length > 0 ? items[items.length - 1].id : from, userId: owner };
  } catch (err) {
    if (missing(err)) return SETUP;
    throw err;
  }
}

// ── Leaving messages ───────────────────────────────────────────────────────────

/** Leaves a message for a person, if they have alerts on (a phone with a key). Never throws: an alert must not break what triggered it. */
export async function enqueue(userId: string, msg: InboxMessage): Promise<boolean> {
  try {
    const rows = rowsOf<{ id: string }>(
      await db.execute(sql`
        insert into notification_inbox (user_id, title, body, url)
        select ${userId}, ${msg.title.slice(0, 80)}, ${msg.body.slice(0, 180)}, ${msg.url ?? null}
        where exists (select 1 from inbox_keys where user_id = ${userId})
        returning id`),
    );
    return rows.length > 0;
  } catch (err) {
    if (!missing(err)) console.warn("[inbox] couldn't leave a message:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** A payout the team just paid or declined. Looks up whose it is, so the caller only needs the kind and id. */
export async function notifyPayout(kind: "shar_claim" | "commission", id: string, outcome: "paid" | "rejected"): Promise<void> {
  const table = kind === "shar_claim" ? sql`shar_claims` : sql`commission_payouts`;
  const owner = rowsOf<{ user_id: string }>(await db.execute(sql`select user_id from ${table} where id = ${id}::uuid`))[0]?.user_id;
  if (!owner) return;
  const what = kind === "shar_claim" ? "claim" : "withdrawal";
  await enqueue(owner, {
    title: outcome === "paid" ? `Your ${what} was paid` : `Your ${what} was declined`,
    body: outcome === "paid" ? "The SKR has been sent to your wallet." : kind === "shar_claim" ? "Open Bluvfi to see why. Your Shar is back in your balance." : "Open Bluvfi to see why. Your money is back in your balance.",
    url: kind === "shar_claim" ? "bluvfi://activity" : "bluvfi://network",
  });
}

/** Someone used a provider. Limited to a few a day per owner, so a busy provider doesn't become a stream of alerts. */
export async function notifyProviderUsed(ownerUserId: string, listingId: string): Promise<void> {
  const { checkApiLimit } = await import("@/lib/user-rate-limiter");
  const ok = await checkApiLimit(ownerUserId, "inbox-provider-used", 1, 6);
  if (!ok.allowed) return;
  const name = rowsOf<{ name: string }>(await db.execute(sql`select name from provider_listings where id = ${listingId}::uuid`))[0]?.name ?? "your provider";
  await enqueue(ownerUserId, { title: "Your provider was used", body: `Someone just used ${name.slice(0, 40)}.`, url: "bluvfi://network" });
}
