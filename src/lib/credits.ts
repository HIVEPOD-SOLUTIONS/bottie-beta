import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { PAYMENTS } from "@/lib/payments-rules";

/**
 * Caller credits: what a person has prepaid for paid provider calls, in whole micro-USDC.
 *
 * Every movement is ONE SQL statement (a data-modifying CTE), so it is atomic even on Neon's HTTP driver, which has no
 * multi-statement transactions. Overspending is impossible by construction: the debit's WHERE clause and the table's CHECK
 * both refuse to take a balance below zero, however many calls race. The ledger is append-only; replays do nothing
 * (a unique index on top-up signatures and on refunds).
 */

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;

export async function getBalanceMicro(userId: string): Promise<number> {
  const [r] = rowsOf<{ balance_micro: string }>(await db.execute(sql`select balance_micro from credit_balances where user_id = ${userId}`));
  return num(r?.balance_micro);
}

/**
 * Credits a verified deposit once. Returns credited=false when this signature was already credited.
 * The signature is first claimed in signature_claims, which an x402 payment also goes through: a signature belongs to a top-up
 * or to an agent's payment, never both, so the same money can't be counted twice.
 */
export async function creditTopup(userId: string, signature: string, micro: number): Promise<{ credited: boolean; balanceMicro: number }> {
  if (!Number.isSafeInteger(micro) || micro < PAYMENTS.minTopupMicro) throw new Error("Top-up amount is below the minimum");
  const [r] = rowsOf<{ inserted: string; balance: string | null }>(
    await db.execute(sql`
      with claim as (
        insert into signature_claims (signature, kind) values (${signature}, 'topup') on conflict do nothing returning signature
      ), ins as (
        insert into credit_ledger (user_id, kind, amount_micro, ref)
        select ${userId}, 'topup', ${micro}, signature from claim
        on conflict (kind, ref) where kind in ('topup', 'refund') do nothing
        returning user_id, amount_micro
      ), bal as (
        insert into credit_balances (user_id, balance_micro)
        select user_id, amount_micro from ins
        on conflict (user_id) do update
          set balance_micro = credit_balances.balance_micro + excluded.balance_micro, updated_at = now()
        returning balance_micro
      )
      select (select count(*) from ins) as inserted, (select balance_micro from bal) as balance`),
  );
  const credited = num(r?.inserted) > 0;
  return { credited, balanceMicro: credited ? num(r?.balance) : await getBalanceMicro(userId) };
}

/** Who has claimed an on-chain signature: "topup", "x402", or null if nobody has. */
export async function signatureOwner(signature: string): Promise<"topup" | "x402" | null> {
  const [r] = rowsOf<{ kind: string }>(await db.execute(sql`select kind from signature_claims where signature = ${signature}`));
  return r?.kind === "topup" || r?.kind === "x402" ? r.kind : null;
}

export type DebitResult = { ok: true; ledgerId: string; balanceMicro: number } | { ok: false; balanceMicro: number };

/** Takes `micro` from the balance only if it is all there, in one statement. */
export async function debitForCall(userId: string, listingId: string, micro: number): Promise<DebitResult> {
  if (!Number.isSafeInteger(micro) || micro <= 0) throw new Error("A debit must be a positive whole number of micro-USDC");
  const [r] = rowsOf<{ id: string | null; balance: string | null }>(
    await db.execute(sql`
      with upd as (
        update credit_balances set balance_micro = balance_micro - ${micro}, updated_at = now()
        where user_id = ${userId} and balance_micro >= ${micro}
        returning user_id, balance_micro
      ), led as (
        insert into credit_ledger (user_id, kind, amount_micro, listing_id)
        select user_id, 'call', ${-micro}, ${listingId}::uuid from upd
        returning id
      )
      select (select id from led) as id, (select balance_micro from upd) as balance`),
  );
  if (r?.id) return { ok: true, ledgerId: r.id, balanceMicro: num(r.balance) };
  return { ok: false, balanceMicro: await getBalanceMicro(userId) };
}

/** Gives back the debit for one call. At most once per call (a unique index on the refund's reference). */
export async function refundCall(userId: string, callLedgerId: string, micro: number): Promise<{ refunded: boolean }> {
  const [r] = rowsOf<{ refunded: string }>(
    await db.execute(sql`
      with ins as (
        insert into credit_ledger (user_id, kind, amount_micro, ref)
        values (${userId}, 'refund', ${micro}, ${callLedgerId})
        on conflict (kind, ref) where kind in ('topup', 'refund') do nothing
        returning user_id, amount_micro
      ), bal as (
        update credit_balances set balance_micro = balance_micro + ins.amount_micro, updated_at = now()
        from ins where credit_balances.user_id = ins.user_id
        returning 1
      )
      select (select count(*) from ins) as refunded`),
  );
  return { refunded: num(r?.refunded) > 0 };
}

/**
 * A call that was charged but never settled nor refunded (the server died mid-call) is refunded once it is old enough that it
 * can't still be running. A settled call is recognised by a provider_usage row that carries the call's ledger id.
 */
export async function sweepOrphanCalls(userId: string, olderThanMs = 3 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const orphans = rowsOf<{ id: string; amount_micro: string }>(
    await db.execute(sql`
      select l.id, l.amount_micro from credit_ledger l
      where l.user_id = ${userId} and l.kind = 'call' and l.created_at < ${cutoff}::timestamp
        and not exists (select 1 from provider_usage u where u.settlement_ref = l.id::text)
        and not exists (select 1 from credit_ledger r where r.kind = 'refund' and r.ref = l.id::text)`),
  );
  let refunded = 0;
  for (const o of orphans) {
    const res = await refundCall(userId, o.id, -num(o.amount_micro));
    if (res.refunded) refunded++;
  }
  return refunded;
}

export async function recentCreditActivity(userId: string, limit = 15) {
  return rowsOf<{ id: string; kind: string; amount_micro: string; listing_name: string | null; created_at: string }>(
    await db.execute(sql`
      select l.id, l.kind, l.amount_micro, p.name as listing_name, l.created_at
      from credit_ledger l left join provider_listings p on p.id = l.listing_id
      where l.user_id = ${userId} order by l.created_at desc limit ${limit}`),
  ).map((r) => ({ id: r.id, kind: r.kind, amountMicro: num(r.amount_micro), listing: r.listing_name, at: new Date(r.created_at).toISOString() }));
}
