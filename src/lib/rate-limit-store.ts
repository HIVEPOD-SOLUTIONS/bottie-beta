import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * Shared counter store for the per-user rate limiter.
 *
 * Counters live in Postgres (table `rate_limits`, one row per bucket) so every serverless instance sees the same
 * count and a cold start or redeploy no longer hands users a fresh allowance. Each hit is one atomic upsert, so
 * concurrent requests can't both slip under a limit.
 *
 * If the database is unreachable the store falls back to an in-process Map (the previous behaviour) rather than
 * failing the request: a DB blip must not take AI chat down, and the fallback is still a per-instance limit.
 *
 * The table is created on first use (`CREATE TABLE IF NOT EXISTS`, same SQL as drizzle/0005_rate_limits.sql), so
 * deploying this doesn't depend on running a migration first.
 */

export interface Hit {
  allowed: boolean;
  count: number;
  /** Epoch ms when this bucket's window ends. */
  resetAt: number;
}

// ── In-memory fallback ───────────────────────────────────────────────────────

const memory = new Map<string, { count: number; resetAt: number }>();

function memoryHit(key: string, windowMs: number, max: number, weight: number): Hit {
  const now = Date.now();
  let b = memory.get(key);
  if (!b || now > b.resetAt) {
    b = { count: Math.min(weight, max + 1), resetAt: now + windowMs };
    memory.set(key, b);
  } else {
    b.count = Math.min(b.count + weight, max + 1);
  }
  if (memory.size > 5000) {
    for (const [k, v] of memory) if (now > v.resetAt) memory.delete(k);
  }
  return { allowed: b.count <= max, count: b.count, resetAt: b.resetAt };
}

// ── Postgres store ───────────────────────────────────────────────────────────

let ready: Promise<void> | null = null;

function ensureTable(): Promise<void> {
  ready ??= (async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS rate_limits (
      key text PRIMARY KEY NOT NULL,
      count integer DEFAULT 0 NOT NULL,
      reset_at timestamp with time zone NOT NULL
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits USING btree (reset_at)`);
  })().catch((err) => {
    ready = null; // retry on the next call
    throw err;
  });
  return ready;
}

type Row = { count: number | string; reset_ms: number | string };

function firstRow(result: unknown): Row | undefined {
  const rows = (result as { rows?: Row[] }).rows ?? (Array.isArray(result) ? (result as Row[]) : []);
  return rows[0];
}

/**
 * Adds `weight` to the bucket (starting a fresh window if the old one has ended) and reports whether the total is
 * still within `max`. The count is capped at max + 1.
 */
export async function hit(key: string, windowMs: number, max: number, weight = 1): Promise<Hit> {
  try {
    await ensureTable();
    const secs = windowMs / 1000;
    // Counts stop at max + 1: hammering a limit that's already hit must not dig a hole an ad bonus or refund can't climb out of.
    const cap = max + 1;
    const result = await db.execute(sql`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (${key}, LEAST(${weight}::int, ${cap}::int), now() + make_interval(secs => ${secs}::float8))
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_limits.reset_at <= now() THEN LEAST(${weight}::int, ${cap}::int) ELSE LEAST(rate_limits.count + ${weight}::int, ${cap}::int) END,
        reset_at = CASE WHEN rate_limits.reset_at <= now() THEN now() + make_interval(secs => ${secs}::float8) ELSE rate_limits.reset_at END
      RETURNING count, (extract(epoch from reset_at) * 1000)::bigint AS reset_ms
    `);
    const row = firstRow(result);
    if (!row) throw new Error("rate_limits upsert returned no row");
    const count = Number(row.count);
    if (Math.random() < 0.01) void prune();
    return { allowed: count <= max, count, resetAt: Number(row.reset_ms) };
  } catch (err) {
    console.warn("[rate-limit] database unavailable, using per-instance counters:", err instanceof Error ? err.message : err);
    return memoryHit(key, windowMs, max, weight);
  }
}

/** Current count of a bucket without adding to it (0 when there is no live window). */
export async function peek(key: string): Promise<{ count: number; resetAt: number } | null> {
  try {
    await ensureTable();
    const result = await db.execute(sql`
      SELECT count, (extract(epoch from reset_at) * 1000)::bigint AS reset_ms
      FROM rate_limits WHERE key = ${key} AND reset_at > now()
    `);
    const row = firstRow(result);
    return row ? { count: Number(row.count), resetAt: Number(row.reset_ms) } : null;
  } catch {
    const b = memory.get(key);
    return b && Date.now() <= b.resetAt ? { count: b.count, resetAt: b.resetAt } : null;
  }
}

/** Takes `amount` back off a live bucket (refunds, ad bonuses), never below zero. Does nothing when there's no live window. */
export async function credit(key: string, amount: number): Promise<void> {
  try {
    await ensureTable();
    await db.execute(sql`
      UPDATE rate_limits SET count = GREATEST(0, count - ${amount}::int) WHERE key = ${key} AND reset_at > now()
    `);
  } catch {
    const b = memory.get(key);
    if (b && Date.now() <= b.resetAt) b.count = Math.max(0, b.count - amount);
  }
}

async function prune(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'`);
  } catch {
    /* housekeeping only */
  }
}

/**
 * Atomically empties a live bucket and returns what it held (0 when there was nothing). Used to claim verified
 * ad-reward credits exactly once, even if two requests race.
 */
export async function takeAll(key: string): Promise<number> {
  try {
    await ensureTable();
    const result = await db.execute(sql`
      WITH old AS (
        SELECT key, count FROM rate_limits WHERE key = ${key} AND reset_at > now() AND count > 0 FOR UPDATE
      )
      UPDATE rate_limits r SET count = 0 FROM old WHERE r.key = old.key RETURNING old.count AS taken
    `);
    const rows = ((result as unknown as { rows?: { taken: number | string }[] }).rows) ?? [];
    return rows[0] ? Number(rows[0].taken) : 0;
  } catch {
    const b = memory.get(key);
    if (b && Date.now() <= b.resetAt && b.count > 0) {
      const taken = b.count;
      b.count = 0;
      return taken;
    }
    return 0;
  }
}
