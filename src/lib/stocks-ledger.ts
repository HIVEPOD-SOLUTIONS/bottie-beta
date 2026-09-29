import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * Per-user stock holdings on Bluvfi's shared Backpack account.
 *
 * Every change is ONE SQL statement (data-modifying CTE) that updates
 * stock_balances and appends to stock_ledger together — the Neon HTTP driver
 * has no multi-statement transactions, and a single statement is atomic.
 *
 * - credit(): idempotent on (kind, ref, asset); a replayed deposit tx or fill
 *   inserts nothing and changes nothing.
 * - debit(): the balance UPDATE only matches if amount >= delta. Postgres
 *   re-checks that condition after taking the row lock, so two concurrent
 *   trades can never both spend the same cash.
 *
 * Amounts are decimal strings; arithmetic happens in Postgres numeric, never
 * in JS floats.
 */

export const CASH = "USDC";

const DECIMAL = /^\d+(\.\d+)?$/;
function assertDecimal(v: string) {
  if (!DECIMAL.test(v)) throw new Error(`Invalid amount "${v}"`);
}

/** Adds `amount` of `asset`. Returns false if this (kind, ref, asset) was already recorded. */
export async function credit(userId: string, asset: string, amount: string, kind: string, ref: string, meta?: string): Promise<boolean> {
  assertDecimal(amount);
  const res = await db.execute(sql`
    WITH entry AS (
      INSERT INTO stock_ledger (user_id, kind, ref, asset, amount, meta)
      VALUES (${userId}, ${kind}, ${ref}, ${asset}, ${amount}::numeric, ${meta ?? null})
      ON CONFLICT (kind, ref, asset) DO NOTHING
      RETURNING user_id, asset, amount
    )
    INSERT INTO stock_balances (user_id, asset, amount)
    SELECT user_id, asset, amount FROM entry
    ON CONFLICT (user_id, asset) DO UPDATE
      SET amount = stock_balances.amount + EXCLUDED.amount, updated_at = now()
    RETURNING 1`);
  return res.rows.length > 0;
}

/**
 * Removes `amount` of `asset` if the user has at least that much. Returns
 * false (and changes nothing) if the balance is too low or this
 * (kind, ref, asset) was already recorded.
 */
export async function debit(userId: string, asset: string, amount: string, kind: string, ref: string, meta?: string): Promise<boolean> {
  assertDecimal(amount);
  const res = await db.execute(sql`
    WITH dup AS (
      SELECT 1 FROM stock_ledger WHERE kind = ${kind} AND ref = ${ref} AND asset = ${asset}
    ),
    upd AS (
      UPDATE stock_balances
      SET amount = amount - ${amount}::numeric, updated_at = now()
      WHERE user_id = ${userId} AND asset = ${asset} AND amount >= ${amount}::numeric
        AND NOT EXISTS (SELECT 1 FROM dup)
      RETURNING user_id
    )
    INSERT INTO stock_ledger (user_id, kind, ref, asset, amount, meta)
    SELECT user_id, ${kind}, ${ref}, ${asset}, -(${amount}::numeric), ${meta ?? null} FROM upd
    RETURNING 1`);
  return res.rows.length > 0;
}

export interface Holding { asset: string; amount: string }

export async function holdings(userId: string): Promise<Holding[]> {
  const res = await db.execute(sql`
    SELECT asset, amount::text AS amount FROM stock_balances
    WHERE user_id = ${userId} AND amount > 0
    ORDER BY asset`);
  return res.rows as unknown as Holding[];
}

export async function balanceOf(userId: string, asset: string): Promise<string> {
  const res = await db.execute(sql`SELECT amount::text AS amount FROM stock_balances WHERE user_id = ${userId} AND asset = ${asset}`);
  return (res.rows[0] as { amount?: string } | undefined)?.amount ?? "0";
}

export interface LedgerEntry { kind: string; ref: string; asset: string; amount: string; meta: string | null; createdAt: string }

export async function history(userId: string, limit = 50): Promise<LedgerEntry[]> {
  const res = await db.execute(sql`
    SELECT kind, ref, asset, amount::text AS amount, meta, created_at AS "createdAt"
    FROM stock_ledger WHERE user_id = ${userId}
    ORDER BY created_at DESC LIMIT ${limit}`);
  return res.rows as unknown as LedgerEntry[];
}
