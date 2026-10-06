import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { sharClaims, sharProfiles } from "@/lib/db/schema";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  SHAR,
  handleFor,
  isReferralCode,
  isSolanaAddress,
  nextWeekStartUtc,
  referralBonus,
  skrForShar,
  tierFor,
  weekStartUtc,
} from "@/lib/shar-rules";

/**
 * Shar balances and the things around them. Spending Shar is *derived* from `payments` on every read (see shar-rules.ts),
 * so there is no earning write to get wrong or repeat. Stored: referral links, claims and provider usage
 * (drizzle/0007_shar_rewards.sql). Until that migration is applied the stored parts read as empty and `ready` is false;
 * the spending half keeps working.
 */

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;

/** Postgres "relation does not exist": the migration hasn't been run. */
export function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  return e?.code === "42P01" || e?.cause?.code === "42P01" || /relation .* does not exist/i.test(`${e?.message} ${e?.cause?.message}`);
}
const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** The qualifying payments, one row each with the Shar they earn (0 for ones that don't qualify). */
function spendCte() {
  const types = sql.join(SHAR.qualifyingTypes.map((t) => sql`${t}`), sql`, `);
  return sql`spend as (
    select id, user_id, status, created_at, description, shar from (
      select p.id, p.user_id, p.status, p.created_at, p.description,
        (case when usd >= ${SHAR.minPurchaseUsd} then floor(usd * ${SHAR.perUsd}) else 0 end) as shar
      from (
        select id, user_id, status, created_at, description,
          (case when amount_usdc ~ '^[0-9]+([.][0-9]+)?$' then amount_usdc::numeric else 0 end) as usd
        from payments
        where type in (${types}) and status in ('completed', 'pending', 'processing')
      ) p
    ) q where shar > 0
  )`;
}

const ts = (d: Date) => sql`${d.toISOString()}::timestamp`;

// ── Profile and referrals ─────────────────────────────────────────────────────

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** The user's Shar profile (referral code), created on first use. */
export async function ensureProfile(userId: string) {
  const [existing] = await db.select().from(sharProfiles).where(eq(sharProfiles.userId, userId)).limit(1);
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [created] = await db.insert(sharProfiles).values({ userId, referralCode: newCode() }).returning();
      return created;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Either a code clash or two requests creating the same profile: look again before retrying.
      const [again] = await db.select().from(sharProfiles).where(eq(sharProfiles.userId, userId)).limit(1);
      if (again) return again;
    }
  }
  throw new Error("Could not create a referral code");
}

export type ReferralResult = { ok: true } | { ok: false; status: number; error: string };

/** Records who referred this person. Once only, never to themselves. */
export async function attachReferral(userId: string, rawCode: unknown): Promise<ReferralResult> {
  const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
  if (!isReferralCode(code)) return { ok: false, status: 400, error: "That code isn't valid." };
  const [referrer] = await db.select().from(sharProfiles).where(eq(sharProfiles.referralCode, code)).limit(1);
  if (!referrer) return { ok: false, status: 404, error: "That code isn't valid." };
  if (referrer.userId === userId) return { ok: false, status: 400, error: "You can't use your own code." };
  await ensureProfile(userId);
  const updated = await db
    .update(sharProfiles)
    // referred_at is the DB clock, the same clock that stamps payments.created_at, so "before" and "after" compare like with like.
    .set({ referredBy: referrer.userId, referredAt: sql`now()` })
    .where(and(eq(sharProfiles.userId, userId), sql`${sharProfiles.referredBy} is null`))
    .returning({ userId: sharProfiles.userId });
  if (updated.length === 0) return { ok: false, status: 409, error: "You've already used a referral code." };
  return { ok: true };
}

// ── Summary ───────────────────────────────────────────────────────────────────

export type ActivityItem = {
  id: string;
  kind: "purchase" | "claim" | "referral" | "provider";
  title: string;
  /** Signed: negative for claims. */
  shar: number;
  state: "available" | "pending" | "requested" | "paid" | "rejected";
  at: string;
};

export async function getSummary(userId: string, now: Date = new Date()) {
  const week = weekStartUtc(now);
  let ready = true;
  const guarded = async <T>(fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (isMissingTable(err)) {
        ready = false;
        return fallback;
      }
      throw err;
    }
  };

  // Spending (derived from payments; never needs the new tables).
  const totals = rowsOf<{ available: string; pending: string; week: string }>(
    await db.execute(sql`
      with ${spendCte()}
      select
        coalesce(sum(shar) filter (where status = 'completed'), 0) as available,
        coalesce(sum(shar) filter (where status in ('pending', 'processing')), 0) as pending,
        coalesce(sum(shar) filter (where status = 'completed' and created_at >= ${ts(week)}), 0) as week
      from spend where user_id = ${userId}`),
  )[0];
  const recentSpend = rowsOf<{ id: string; status: string; created_at: string; description: string; shar: string }>(
    await db.execute(sql`
      with ${spendCte()}
      select id, status, created_at, description, shar from spend where user_id = ${userId} order by created_at desc limit 20`),
  );

  const profile = await guarded(null, () => ensureProfile(userId));

  const referees = await guarded([] as { shar: string }[], async () =>
    rowsOf<{ shar: string }>(
      await db.execute(sql`
        with ${spendCte()}
        select s.user_id, coalesce(sum(s.shar) filter (where s.status = 'completed'), 0) as shar
        from spend s join shar_profiles r on r.user_id = s.user_id
        where r.referred_by = ${userId}
          -- Only spending after the code was entered counts. A row with no referred_at (a link made before this rule existed)
          -- earns nothing rather than risk paying for spending that came first.
          and r.referred_at is not null and s.created_at >= r.referred_at
        group by s.user_id`),
    ),
  );
  const referredCount = await guarded(0, async () => {
    const [r] = rowsOf<{ n: string }>(await db.execute(sql`select count(*) as n from shar_profiles where referred_by = ${userId}`));
    return num(r?.n);
  });
  const bonus = referees.reduce((sum, r) => sum + referralBonus(num(r.shar)), 0);

  const provider = await guarded({ total: 0, week: 0, owned: 0 }, async () => {
    const [r] = rowsOf<{ total: string; week: string; owned: string }>(
      await db.execute(sql`
        select
          coalesce((select sum(u.shar) from provider_usage u join provider_listings l on l.id = u.listing_id where l.owner_user_id = ${userId}), 0) as total,
          coalesce((select sum(u.shar) from provider_usage u join provider_listings l on l.id = u.listing_id where l.owner_user_id = ${userId} and u.created_at >= ${ts(week)}), 0) as week,
          (select count(*) from provider_listings where owner_user_id = ${userId}) as owned`),
    );
    return { total: num(r?.total), week: num(r?.week), owned: num(r?.owned) };
  });
  const providerEvents = await guarded([] as { id: string; name: string; shar: number; created_at: string }[], async () =>
    rowsOf<{ id: string; name: string; shar: number; created_at: string }>(
      await db.execute(sql`
        select u.id, l.name, u.shar, u.created_at from provider_usage u join provider_listings l on l.id = u.listing_id
        where l.owner_user_id = ${userId} and u.shar > 0 order by u.created_at desc limit 10`),
    ),
  );

  const claims = await guarded([] as (typeof sharClaims.$inferSelect)[], () =>
    db.select().from(sharClaims).where(eq(sharClaims.userId, userId)).orderBy(desc(sharClaims.createdAt)).limit(10),
  );
  const claimed = claims.filter((c) => c.status === "requested" || c.status === "paid").reduce((s, c) => s + c.shar, 0);
  const claimedAll = await guarded(claimed, async () => {
    const [r] = rowsOf<{ n: string }>(
      await db.execute(sql`select coalesce(sum(shar), 0) as n from shar_claims where user_id = ${userId} and status in ('requested', 'paid')`),
    );
    return num(r?.n);
  });

  const earned = num(totals?.available) + bonus + provider.total; // before claims; what the ladder is measured on
  const available = Math.max(0, earned - claimedAll);

  const activity: ActivityItem[] = [
    ...recentSpend.map((r): ActivityItem => ({
      id: `p:${r.id}`,
      kind: "purchase",
      title: r.description,
      shar: num(r.shar),
      state: r.status === "completed" ? "available" : "pending",
      at: new Date(r.created_at).toISOString(),
    })),
    ...providerEvents.map((e): ActivityItem => ({
      id: `u:${e.id}`,
      kind: "provider",
      title: `${e.name} was used`,
      shar: e.shar,
      state: "available",
      at: new Date(e.created_at).toISOString(),
    })),
    ...claims.map((c): ActivityItem => ({
      id: `c:${c.id}`,
      kind: "claim",
      title: c.status === "paid" ? "Claimed as SKR" : c.status === "rejected" ? "Claim declined" : "SKR claim requested",
      shar: c.status === "rejected" ? 0 : -c.shar,
      state: c.status as ActivityItem["state"],
      at: c.createdAt.toISOString(),
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 25);

  const open = claims.find((c) => c.status === "requested") ?? null;
  return {
    ready,
    available,
    pending: num(totals?.pending),
    lifetime: earned,
    week: num(totals?.week) + provider.week,
    weekEndsAt: nextWeekStartUtc(now).toISOString(),
    tier: tierFor(earned),
    skr: { perShar: SHAR.skrPerShar, availableSkr: skrForShar(available) },
    claim: {
      minShar: SHAR.minClaimShar,
      open: open && { id: open.id, shar: open.shar, skr: open.skrAmount, wallet: open.wallet, at: open.createdAt.toISOString() },
    },
    referral: { code: profile?.referralCode ?? null, referred: referredCount, bonus },
    provider: { owned: provider.owned, earned: provider.total },
    activity,
    rules: {
      perUsd: SHAR.perUsd,
      minPurchaseUsd: SHAR.minPurchaseUsd,
      referralBonusPct: Math.round(SHAR.referralBonusRate * 100),
      providerUseShar: SHAR.providerUseShar,
      skrPerShar: SHAR.skrPerShar,
      minClaimShar: SHAR.minClaimShar,
    },
  };
}

// ── Weekly leaderboard ────────────────────────────────────────────────────────

export async function getLeaderboard(userId: string, now: Date = new Date()) {
  const week = weekStartUtc(now);
  const run = (withProviders: boolean) =>
    db.execute(sql`
      with ${spendCte()}, weekly as (
        select user_id, shar from spend where status = 'completed' and created_at >= ${ts(week)}
        ${withProviders
          ? sql`union all
        select l.owner_user_id as user_id, u.shar from provider_usage u join provider_listings l on l.id = u.listing_id
        where u.shar > 0 and u.created_at >= ${ts(week)}`
          : sql``}
      )
      select user_id, sum(shar)::int as shar from weekly group by user_id order by shar desc, user_id asc limit 50`);
  let res;
  try {
    res = await run(true);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    res = await run(false);
  }
  const all = rowsOf<{ user_id: string; shar: number }>(res);
  const top = await Promise.all(
    all.slice(0, SHAR.leaderboardSize).map(async (r, i) => ({
      rank: i + 1,
      handle: await handleFor(r.user_id),
      shar: num(r.shar),
      you: r.user_id === userId,
    })),
  );
  const mineIdx = all.findIndex((r) => r.user_id === userId);
  return {
    weekStartsAt: week.toISOString(),
    weekEndsAt: nextWeekStartUtc(now).toISOString(),
    top,
    me: { rank: mineIdx >= 0 ? mineIdx + 1 : null, shar: mineIdx >= 0 ? num(all[mineIdx].shar) : 0 },
  };
}

// ── Claims ────────────────────────────────────────────────────────────────────

export type ClaimResult =
  | { ok: true; claim: { id: string; shar: number; skr: string; wallet: string } }
  | { ok: false; status: number; error: string };

/**
 * Asks for Shar to be paid out as SKR. The amount and SKR are fixed now; the team sends the SKR and marks the claim paid.
 * The one-open-claim-per-user index is what keeps two quick taps from creating two claims against the same balance.
 */
export async function createClaim(userId: string, body: { shar?: unknown; wallet?: unknown }): Promise<ClaimResult> {
  const shar = Number(body.shar);
  if (!Number.isInteger(shar) || shar < SHAR.minClaimShar) {
    return { ok: false, status: 400, error: `The smallest claim is ${SHAR.minClaimShar} Shar.` };
  }
  if (!isSolanaAddress(body.wallet)) return { ok: false, status: 400, error: "Enter a valid Solana wallet address." };

  const summary = await getSummary(userId);
  if (!summary.ready) return { ok: false, status: 503, error: "Claims are being set up. Try again soon." };
  if (summary.claim.open) return { ok: false, status: 409, error: "You already have a claim in progress." };
  if (shar > summary.available) return { ok: false, status: 400, error: "That's more than your available Shar." };

  const skr = skrForShar(shar);
  try {
    const [row] = await db.insert(sharClaims).values({ userId, shar, skrAmount: skr, wallet: body.wallet }).returning();
    return { ok: true, claim: { id: row.id, shar, skr, wallet: body.wallet } };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, status: 409, error: "You already have a claim in progress." };
    throw err;
  }
}
