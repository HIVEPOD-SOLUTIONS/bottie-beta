import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ABUSE, deviceHash, overDeviceClaimLimit, riskFlags, type RiskAssessment } from "@/lib/abuse-rules";

/**
 * Linking accounts by phone and by payout wallet. See abuse-rules.ts for the why.
 *
 * Everything here fails SAFE for the user: if the device table doesn't exist yet, or a query fails, ordinary requests go ahead
 * (we never break a purchase or a claim because a check couldn't run). The one place a person decides is the payout, where the
 * admin sees what the checks found and, when something is flagged, has to acknowledge it.
 */

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;
const missing = (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string } };
  return /(relation|column) .* does not exist/i.test(`${e?.message} ${e?.cause?.message}`);
};

/** Remembers that this account used this phone. Never throws: a failed note must not break the request it rode on. */
export async function recordDevice(userId: string, rawDevice: unknown): Promise<void> {
  const hash = deviceHash(rawDevice);
  if (!hash) return;
  try {
    await db.execute(sql`
      insert into user_devices (user_id, device_hash) values (${userId}, ${hash})
      on conflict (user_id, device_hash) do update set last_seen = now()`);
    // Keep only the most recently used few, so an account can't pile up phones.
    await db.execute(sql`
      delete from user_devices where user_id = ${userId} and device_hash in (
        select device_hash from user_devices where user_id = ${userId} order by last_seen desc offset ${ABUSE.maxDevicesPerAccount})`);
  } catch (err) {
    if (!missing(err)) console.warn("[abuse] couldn't record the device:", err instanceof Error ? err.message : err);
  }
}

/** Reads the app's device header and remembers it for this account. */
export const noteDevice = (req: Request, userId: string) => recordDevice(userId, req.headers?.get?.("x-bluvfi-device"));

/** Other accounts that have used any of this account's phones; null when the device table isn't there yet. */
async function accountsOnMyDevices(userId: string): Promise<string[] | null> {
  try {
    return rowsOf<{ user_id: string }>(
      await db.execute(sql`
        select distinct o.user_id from user_devices m
        join user_devices o on o.device_hash = m.device_hash and o.user_id <> ${userId}
        where m.user_id = ${userId}`),
    ).map((r) => r.user_id);
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

async function accountsOnWallet(userId: string, wallet: string): Promise<string[]> {
  return rowsOf<{ user_id: string }>(
    await db.execute(sql`
      select user_id from shar_claims where wallet = ${wallet} and user_id <> ${userId} and status <> 'rejected'
      union
      select user_id from commission_payouts where wallet = ${wallet} and user_id <> ${userId} and status <> 'rejected'`),
  ).map((r) => r.user_id);
}

/** How many of these accounts have a claim or withdrawal that wasn't declined. */
async function countClaiming(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const [r] = rowsOf<{ n: string }>(
    await db.execute(sql`
      select count(*) as n from (
        select user_id from shar_claims where user_id in (${list}) and status <> 'rejected'
        union select user_id from commission_payouts where user_id in (${list}) and status <> 'rejected'
      ) x`),
  );
  return num(r?.n);
}

async function countPaid(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const [r] = rowsOf<{ n: string }>(
    await db.execute(sql`
      select count(*) as n from (
        select user_id from shar_claims where user_id in (${list}) and status = 'paid'
        union select user_id from commission_payouts where user_id in (${list}) and status = 'paid'
      ) x`),
  );
  return num(r?.n);
}

/** What the checks find about paying this account's money to this wallet. */
export async function assessRisk(userId: string, wallet: string): Promise<RiskAssessment> {
  const onDevices = await accountsOnMyDevices(userId);
  const onWallet = await accountsOnWallet(userId, wallet);
  const linked = [...new Set([...(onDevices ?? []), ...onWallet])];
  const flags = riskFlags({ otherAccountsOnDevice: onDevices?.length ?? 0, otherAccountsOnWallet: onWallet.length, linkedPaidAccounts: await countPaid(linked) });

  let info: RiskAssessment["info"] = [];
  if (onDevices !== null) {
    const [mine] = rowsOf<{ n: string }>(await db.execute(sql`select count(*) as n from user_devices where user_id = ${userId}`));
    if (num(mine?.n) === 0) info = ["no_device"];
  }
  return { flags, info, linkedAccounts: linked.length, deviceChecks: onDevices !== null };
}

/** True when too many OTHER accounts on this account's phones have already claimed, so another claim isn't accepted. */
export async function claimBlockedByDevice(userId: string): Promise<boolean> {
  try {
    const others = await accountsOnMyDevices(userId);
    if (!others || others.length === 0) return false;
    return overDeviceClaimLimit(await countClaiming(others));
  } catch (err) {
    console.warn("[abuse] device claim check failed (allowing):", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Whether two accounts have used the same phone. False when it can't be known (no phone on record, or no table yet). */
export async function sharesDevice(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    const rows = rowsOf<{ one: number }>(
      await db.execute(sql`
        select 1 as one from user_devices x join user_devices y on y.device_hash = x.device_hash
        where x.user_id = ${a} and y.user_id = ${b} limit 1`),
    );
    return rows.length > 0;
  } catch (err) {
    if (!missing(err)) console.warn("[abuse] shared-device check failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
