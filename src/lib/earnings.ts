import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimBlockedByDevice } from "@/lib/abuse";
import { PAYMENTS, isPayableAddress } from "@/lib/payments-rules";

/**
 * Owner commission from paid provider calls (80% of each paid call, see payments-rules.ts), and withdrawing it as SKR.
 * A withdrawal moves the whole available balance into one payout request in a single statement, so the same money can never
 * be requested twice. An admin then clicks Pay (see skr-payout.ts).
 */

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;
const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

export async function getEarnings(userId: string) {
  const [bal] = rowsOf<{ available_micro: string; lifetime_micro: string }>(
    await db.execute(sql`select available_micro, lifetime_micro from earnings_balances where user_id = ${userId}`),
  );
  const payouts = rowsOf<{ id: string; usd_micro: string; skr_micro: string | null; status: string; wallet: string; created_at: string; paid_at: string | null; tx_signature: string | null }>(
    await db.execute(sql`
      select id, usd_micro, skr_micro, status, wallet, created_at, paid_at, tx_signature
      from commission_payouts where user_id = ${userId} order by created_at desc limit 10`),
  ).map((p) => ({
    id: p.id,
    usdMicro: num(p.usd_micro),
    skrMicro: p.skr_micro === null ? null : num(p.skr_micro),
    status: p.status === "processing" || p.status === "sent" ? "sending" : p.status,
    wallet: p.wallet,
    at: new Date(p.created_at).toISOString(),
    paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null,
    tx: p.tx_signature,
  }));
  const available = num(bal?.available_micro);
  const open = payouts.find((p) => p.status === "requested" || p.status === "sending") ?? null;
  return {
    availableMicro: available,
    lifetimeMicro: num(bal?.lifetime_micro),
    minWithdrawMicro: PAYMENTS.minWithdrawMicro,
    ownerPct: PAYMENTS.ownerBps / 100,
    canWithdraw: available >= PAYMENTS.minWithdrawMicro && !open,
    open,
    payouts,
  };
}

export type WithdrawResult =
  | { ok: true; payout: { id: string; usdMicro: number; wallet: string } }
  | { ok: false; status: number; error: string };

/** Moves all available commission into a payout request, to be paid as SKR to `wallet`. */
export async function requestWithdrawal(userId: string, wallet: unknown): Promise<WithdrawResult> {
  if (!isPayableAddress(wallet)) return { ok: false, status: 400, error: "Enter a valid Solana wallet address." };
  if (await claimBlockedByDevice(userId)) return { ok: false, status: 409, error: "Too many accounts have claimed from this phone, so this can't go ahead. Contact support if that's a mistake." };
  try {
    const [r] = rowsOf<{ id: string; usd_micro: string }>(
      await db.execute(sql`
        with cur as (
          select available_micro from earnings_balances where user_id = ${userId} for update
        ), upd as (
          update earnings_balances set available_micro = 0, updated_at = now()
          from cur where earnings_balances.user_id = ${userId} and cur.available_micro >= ${PAYMENTS.minWithdrawMicro}
          returning cur.available_micro as amt
        )
        insert into commission_payouts (user_id, usd_micro, wallet)
        select ${userId}, amt, ${wallet} from upd
        returning id, usd_micro`),
    );
    if (!r) {
      const [b] = rowsOf<{ available_micro: string }>(await db.execute(sql`select available_micro from earnings_balances where user_id = ${userId}`));
      const have = num(b?.available_micro);
      return { ok: false, status: 400, error: have === 0 ? "You have no commission to withdraw yet." : `The smallest withdrawal is $${PAYMENTS.minWithdrawMicro / 1_000_000}.` };
    }
    return { ok: true, payout: { id: r.id, usdMicro: num(r.usd_micro), wallet } };
  } catch (err) {
    // One open payout per person (a unique index). The statement is atomic, so the balance was not touched.
    if (isUniqueViolation(err)) return { ok: false, status: 409, error: "You already have a withdrawal in progress." };
    throw err;
  }
}
