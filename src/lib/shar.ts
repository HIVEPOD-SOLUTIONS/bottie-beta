import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { claimBlockedByDevice, sharesDevice, sparkBlockedByDevice } from "@/lib/abuse";
import { db } from "@/lib/db";
import { sharClaims, sharProfiles } from "@/lib/db/schema";
import {
  SPARK,
  WEEKLY_PRIZE_MIN_SHAR,
  WEEKLY_PRIZE_SHAR,
  badgesFor,
  dayBefore,
  liveStreak,
  nextSparkAt,
  sparkDay,
  sparkReward,
  streakAfterCollecting,
} from "@/lib/shar-spark-rules";
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

/**
 * Postgres "relation does not exist" (42P01) or "column does not exist" (42703): a migration hasn't been run yet. Either way the
 * feature reports "being set up" instead of crashing, so the code can be deployed before or after its migration.
 */
export function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (code === "42P01" || code === "42703") return true;
  return /(relation|column) .* does not exist/i.test(`${e?.message} ${e?.cause?.message}`);
}
const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** The qualifying payments, one row each with the Shar they earn (0 for ones that don't qualify). */
export function spendCte() {
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
  // A code from another account on the same phone is the same person: it would only ever pay out to themselves.
  if (await sharesDevice(userId, referrer.userId)) return { ok: false, status: 400, error: "You can't use a code from an account on the same phone." };
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
  kind: "purchase" | "claim" | "referral" | "provider" | "spark" | "prize";
  title: string;
  /** Signed: negative for claims. */
  shar: number;
  /** "sending": an admin has started the payout; it is on its way. */
  state: "available" | "pending" | "requested" | "sending" | "paid" | "rejected";
  at: string;
};

/** The Daily Spark card: the live streak, whether today's is collected, what the next one is worth, and the last 7 days. */
export function sparkState(rows: { day: string; shar: number; streak: number; seeker: boolean }[], today: string, now: Date, ready: boolean) {
  const last = rows[0] ?? null;
  const live = liveStreak(last, today);
  const seeker = !!last?.seeker;
  // What the next collect pays: the live streak plus one, whether that collect is today's or tomorrow's.
  const nextStreak = live.streak + 1;
  const reward = sparkReward(nextStreak, seeker);
  const have = new Set(rows.map((r) => r.day));
  const days = Array.from({ length: 7 }, (_, i) => {
    let d = today;
    for (let k = 0; k < 6 - i; k++) d = dayBefore(d);
    return { day: d, collected: have.has(d), today: d === today };
  });
  return {
    ready,
    streak: live.streak,
    collectedToday: live.collectedToday,
    nextAt: nextSparkAt(now).toISOString(),
    next: { streak: nextStreak, ...reward },
    seeker,
    days,
    rules: { baseShar: SPARK.baseShar, weekBonusShar: SPARK.weekBonusShar, seekerMultiplier: SPARK.seekerMultiplier, streakTiers: SPARK.streakTiers },
  };
}

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
  // A claim still counts against the balance while it is being paid, not only while it waits: otherwise Shar would come back mid-payout.
  const COUNTS = ["requested", "processing", "sent", "paid"];
  const claimed = claims.filter((c) => COUNTS.includes(c.status)).reduce((s, c) => s + c.shar, 0);
  const claimedAll = await guarded(claimed, async () => {
    const [r] = rowsOf<{ n: string }>(
      await db.execute(sql`select coalesce(sum(shar), 0) as n from shar_claims where user_id = ${userId} and status in ('requested', 'processing', 'sent', 'paid')`),
    );
    return num(r?.n);
  });

  // Daily Spark and the badge facts. Their table is a separate migration (0016), so a missing table never flips `ready` (that would block claims):
  // sparks just read as empty until it exists.
  const weekDay = week.toISOString().slice(0, 10);
  const today = sparkDay(now);
  let sparksReady = true;
  const sparkRows = await (async () => {
    try {
      return rowsOf<{ day: string; shar: number; streak: number; seeker: boolean }>(
        await db.execute(sql`
          select to_char(day, 'YYYY-MM-DD') as day, shar, streak, seeker from shar_sparks where user_id = ${userId} order by day desc limit 60`),
      );
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      sparksReady = false;
      return [];
    }
  })();
  const sparkTotals = await (async () => {
    if (!sparksReady) return { total: 0, week: 0, count: 0, best: 0 };
    const [r] = rowsOf<{ total: string; week: string; count: string; best: string }>(
      await db.execute(sql`
        select coalesce(sum(shar), 0) as total,
               coalesce(sum(shar) filter (where day >= ${weekDay}::date), 0) as week,
               count(*) as count, coalesce(max(streak), 0) as best
        from shar_sparks where user_id = ${userId}`),
    );
    return { total: num(r?.total), week: num(r?.week), count: num(r?.count), best: num(r?.best) };
  })();
  const purchases = await (async () => {
    const [r] = rowsOf<{ n: string }>(await db.execute(sql`select count(*) as n from payments where user_id = ${userId} and type = 'bill' and status = 'completed'`));
    return num(r?.n);
  })();
  const claimsMade = claims.filter((c) => c.status !== "rejected").length;
  // Weekly prizes: last week's, paid the first time anyone loads Shar after it closed (a no-op until the team sets prizes), then totalled.
  await settleLastWeek(now).catch((err) => console.warn("[shar] couldn't settle last week's prizes:", err instanceof Error ? err.message : err));
  const awards = await (async () => {
    try {
      const [t] = rowsOf<{ total: string }>(await db.execute(sql`select coalesce(sum(shar), 0) as total from shar_weekly_awards where user_id = ${userId}`));
      const recent = rowsOf<{ week_start: string; place: number; shar: number }>(
        await db.execute(sql`select to_char(week_start, 'YYYY-MM-DD') as week_start, place, shar from shar_weekly_awards where user_id = ${userId} order by week_start desc limit 5`),
      );
      return { total: num(t?.total), recent };
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      return { total: 0, recent: [] as { week_start: string; place: number; shar: number }[] };
    }
  })();
  const inSquad = await (async () => {
    try {
      return rowsOf<{ one: number }>(await db.execute(sql`select 1 as one from shar_squad_members where user_id = ${userId} limit 1`)).length > 0;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      return false;
    }
  })();

  const earned = num(totals?.available) + bonus + provider.total + sparkTotals.total + awards.total; // before claims; what the ladder is measured on
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
    ...sparkRows.slice(0, 10).map((r): ActivityItem => ({
      id: `s:${r.day}`,
      kind: "spark",
      title: `Daily Spark · day ${r.streak}`,
      shar: r.shar,
      state: "available",
      at: new Date(`${r.day}T12:00:00Z`).toISOString(),
    })),
    ...awards.recent.map((a): ActivityItem => ({
      id: `w:${a.week_start}`,
      kind: "prize",
      title: `Weekly trial · place #${a.place}`,
      shar: a.shar,
      state: "available",
      // Paid when the week closed: the Monday after the week it was won.
      at: new Date(`${a.week_start}T00:00:00Z`).getTime() + 7 * 86_400_000 > now.getTime() ? now.toISOString() : new Date(new Date(`${a.week_start}T00:00:00Z`).getTime() + 7 * 86_400_000).toISOString(),
    })),
    ...claims.map((c): ActivityItem => ({
      id: `c:${c.id}`,
      kind: "claim",
      title: c.status === "paid" ? "Claimed as SKR" : c.status === "rejected" ? "Claim declined" : c.status === "processing" || c.status === "sent" ? "SKR on its way" : "SKR claim requested",
      shar: c.status === "rejected" ? 0 : -c.shar,
      state: (c.status === "processing" || c.status === "sent" ? "sending" : c.status) as ActivityItem["state"],
      at: c.createdAt.toISOString(),
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 25);

  const open = claims.find((c) => c.status === "requested" || c.status === "processing" || c.status === "sent") ?? null;
  return {
    ready,
    available,
    pending: num(totals?.pending),
    lifetime: earned,
    week: num(totals?.week) + provider.week + sparkTotals.week,
    weekEndsAt: nextWeekStartUtc(now).toISOString(),
    tier: tierFor(earned),
    skr: { perShar: SHAR.skrPerShar, availableSkr: skrForShar(available) },
    claim: {
      minShar: SHAR.minClaimShar,
      open: open && { id: open.id, shar: open.shar, skr: open.skrAmount, wallet: open.wallet, at: open.createdAt.toISOString(), sending: open.status !== "requested" },
    },
    referral: { code: profile?.referralCode ?? null, referred: referredCount, bonus },
    provider: { owned: provider.owned, earned: provider.total },
    spark: sparkState(sparkRows, today, now, sparksReady),
    badges: badgesFor({
      sparks: sparkTotals.count,
      bestStreak: sparkTotals.best,
      purchases,
      referred: referredCount,
      providersOwned: provider.owned,
      claims: claimsMade,
      seeker: sparkRows.some((r) => r.seeker),
      inSquad,
    }),
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

// ── Weekly totals, the leaderboard, squads' totals and weekly prizes ──────────────

/** A window of the week's Shar: from Monday 00:00 UTC, up to (not including) `to` when it is a past week. */
export type WeeklyWindow = { from: Date; to?: Date };

/** The Shar each person earned in the window: completed purchases, provider uses and Daily Sparks. Needs a `with ` in front. */
function weeklyCte(win: WeeklyWindow, withProviders: boolean, withSparks: boolean): SQL {
  const fromDay = win.from.toISOString().slice(0, 10);
  const toDay = win.to ? win.to.toISOString().slice(0, 10) : null;
  const before = (col: SQL) => (win.to ? sql` and ${col} < ${ts(win.to)}` : sql``);
  return sql`${spendCte()}, weekly as (
    select user_id, shar from spend where status = 'completed' and created_at >= ${ts(win.from)}${before(sql`created_at`)}
    ${withProviders
      ? sql`union all
    select l.owner_user_id as user_id, u.shar from provider_usage u join provider_listings l on l.id = u.listing_id
    where u.shar > 0 and u.created_at >= ${ts(win.from)}${before(sql`u.created_at`)}`
      : sql``}
    ${withSparks
      ? sql`union all
    select user_id, shar from shar_sparks where day >= ${fromDay}::date${toDay ? sql` and day < ${toDay}::date` : sql``}`
      : sql``}
  )`;
}

/**
 * Runs a query over the weekly totals. Each optional source is its own migration, so this falls back one step at a time (providers and
 * sparks, then providers only, then purchases only) instead of failing when one has not been applied yet.
 */
export async function withWeekly<T>(win: WeeklyWindow, run: (cte: SQL) => Promise<T>): Promise<T> {
  for (const [p, sp] of [[true, true], [true, false], [false, false]] as const) {
    try {
      return await run(weeklyCte(win, p, sp));
    } catch (err) {
      if (!isMissingTable(err) || (!p && !sp)) throw err;
    }
  }
  throw new Error("unreachable");
}

/** Everyone's Shar in the window, biggest first (ties by id so the order never wobbles), optionally only some people. */
export async function weeklyTotals(win: WeeklyWindow, opts: { userIds?: string[]; limit?: number } = {}): Promise<{ user_id: string; shar: number }[]> {
  if (opts.userIds && opts.userIds.length === 0) return [];
  const only = opts.userIds ? sql`where user_id in (${sql.join(opts.userIds.map((i) => sql`${i}`), sql`, `)})` : sql``;
  const cap = sql`limit ${opts.limit ?? 50}`;
  const res = await withWeekly(win, (cte) =>
    db.execute(sql`with ${cte} select user_id, sum(shar)::int as shar from weekly ${only} group by user_id order by shar desc, user_id asc ${cap}`),
  );
  return rowsOf<{ user_id: string; shar: number }>(res).map((r) => ({ user_id: r.user_id, shar: num(r.shar) }));
}

export async function getLeaderboard(userId: string, now: Date = new Date()) {
  const week = weekStartUtc(now);
  const all = await weeklyTotals({ from: week }, { limit: 50 });
  const topRows = all.slice(0, SHAR.leaderboardSize);
  // Which of the top few are verified Seeker holders (as of their latest spark), for a badge beside their name.
  const seekers = new Set<string>();
  if (topRows.length > 0) {
    try {
      const list = sql.join(topRows.map((r) => sql`${r.user_id}`), sql`, `);
      for (const r of rowsOf<{ user_id: string }>(
        await db.execute(sql`select distinct on (user_id) user_id from shar_sparks where user_id in (${list}) and seeker order by user_id, day desc`),
      )) seekers.add(r.user_id);
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
  }
  const top = await Promise.all(
    topRows.map(async (r, i) => ({
      rank: i + 1,
      handle: await handleFor(r.user_id),
      shar: num(r.shar),
      you: r.user_id === userId,
      seeker: seekers.has(r.user_id),
      prizeShar: WEEKLY_PRIZE_SHAR[i] && num(r.shar) >= WEEKLY_PRIZE_MIN_SHAR ? WEEKLY_PRIZE_SHAR[i] : null,
    })),
  );
  const mineIdx = all.findIndex((r) => r.user_id === userId);
  return {
    weekStartsAt: week.toISOString(),
    weekEndsAt: nextWeekStartUtc(now).toISOString(),
    top,
    me: { rank: mineIdx >= 0 ? mineIdx + 1 : null, shar: mineIdx >= 0 ? num(all[mineIdx].shar) : 0 },
    /** The prizes by place, in Shar and the SKR it converts to; empty means none are promised. */
    prizes: WEEKLY_PRIZE_SHAR.map((shar, i) => ({ place: i + 1, shar, skr: skrForShar(shar) })),
    prizeMinShar: WEEKLY_PRIZE_MIN_SHAR,
  };
}

/**
 * Pays last week's prizes, once. Does nothing until the team has set prizes. The prizes are Shar (claimed as SKR the usual way), the
 * whole week is written in ONE statement, and (week, user) is the key, so running this twice, or twice at once, can't pay anyone twice.
 * Called when anyone loads their Shar after the week closed; there is no scheduler to set up. Returns how many prizes were paid.
 */
export async function settleLastWeek(now: Date = new Date()): Promise<number> {
  if (WEEKLY_PRIZE_SHAR.length === 0) return 0;
  const thisWeek = weekStartUtc(now);
  const last = new Date(thisWeek);
  last.setUTCDate(last.getUTCDate() - 7);
  const lastDay = last.toISOString().slice(0, 10);
  try {
    if (rowsOf<{ one: number }>(await db.execute(sql`select 1 as one from shar_weekly_awards where week_start = ${lastDay}::date limit 1`)).length > 0) return 0;
    const winners = (await weeklyTotals({ from: last, to: thisWeek }, { limit: WEEKLY_PRIZE_SHAR.length }))
      .map((r, i) => ({ userId: r.user_id, place: i + 1, shar: WEEKLY_PRIZE_SHAR[i], earned: r.shar }))
      .filter((w) => w.shar > 0 && w.earned >= WEEKLY_PRIZE_MIN_SHAR);
    if (winners.length === 0) return 0;
    const values = sql.join(winners.map((w) => sql`(${lastDay}::date, ${w.userId}, ${w.place}, ${w.shar})`), sql`, `);
    const inserted = rowsOf<{ user_id: string }>(
      await db.execute(sql`insert into shar_weekly_awards (week_start, user_id, place, shar) values ${values} on conflict (week_start, user_id) do nothing returning user_id`),
    );
    return inserted.length;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
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
    return { ok: false, status: 400, error: `The smallest claim is ${SHAR.minClaimShar.toLocaleString("en-US")} Shar.` };
  }
  if (!isSolanaAddress(body.wallet)) return { ok: false, status: 400, error: "Enter a valid Solana wallet address." };
  if (await claimBlockedByDevice(userId)) return { ok: false, status: 409, error: "Too many accounts have claimed from this phone, so this can't go ahead. Contact support if that's a mistake." };

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

// ── Daily Spark ───────────────────────────────────────────────────────────────

export type SparkResult =
  | { ok: true; streak: number; shar: number; daily: number; bonus: number; multiplier: number; seeker: boolean; day: string }
  | { ok: false; status: number; error: string };

/**
 * Collects today's Daily Spark. The (user, day) primary key is the once-a-day guard, so two taps at once pay once: the second insert
 * finds the row and is told it is already collected. A verified Seeker Genesis Token holder (checked here, on the server) gets the Seeker multiplier.
 */
export async function collectSpark(userId: string, now: Date = new Date()): Promise<SparkResult> {
  const day = sparkDay(now);
  let last: { day: string; streak: number } | null;
  try {
    last = rowsOf<{ day: string; streak: number }>(
      await db.execute(sql`select to_char(day, 'YYYY-MM-DD') as day, streak from shar_sparks where user_id = ${userId} order by day desc limit 1`),
    )[0] ?? null;
  } catch (err) {
    if (isMissingTable(err)) return { ok: false, status: 503, error: "Daily Spark is being set up. Try again soon." };
    throw err;
  }
  if (last?.day === day) return { ok: false, status: 409, error: "You've already collected today's spark. It comes back at midnight UTC." };
  if (await sparkBlockedByDevice(userId, day)) {
    return { ok: false, status: 409, error: "Another account on this phone has already collected today's spark." };
  }

  // Loaded here, not at the top: it pulls in the Privy client, which the rest of Shar (and its tests) never needs.
  const { isSeekerHolder } = await import("@/lib/seeker-sgt");
  const seeker = await isSeekerHolder(userId);
  const streak = streakAfterCollecting(last, day);
  const reward = sparkReward(streak, seeker);
  try {
    const inserted = rowsOf<{ day: string }>(
      await db.execute(sql`
        insert into shar_sparks (user_id, day, shar, streak, seeker) values (${userId}, ${day}::date, ${reward.shar}, ${streak}, ${seeker})
        on conflict (user_id, day) do nothing returning day`),
    );
    if (inserted.length === 0) return { ok: false, status: 409, error: "You've already collected today's spark. It comes back at midnight UTC." };
  } catch (err) {
    if (isMissingTable(err)) return { ok: false, status: 503, error: "Daily Spark is being set up. Try again soon." };
    throw err;
  }
  return { ok: true, day, streak, shar: reward.shar, daily: reward.daily, bonus: reward.bonus, multiplier: reward.multiplier, seeker };
}
