import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { handleFor, nextWeekStartUtc, weekStartUtc } from "@/lib/shar-rules";
import { isMissingTable, weeklyTotals, withWeekly } from "@/lib/shar";
import { SQUAD, SQUAD_CODE_ALPHABET, cleanSquadName, isSquadCode, squadHandle, squadProgress } from "@/lib/shar-squad-rules";

/**
 * Squads: friends pooling toward a weekly Shar goal (rules in shar-squad-rules.ts; tables in drizzle/0017). A squad's week is the sum of
 * its members' Shar for the week, counted by the same code as the weekly board. Reaching the goal is recognition only: nothing here
 * creates Shar. Strangers only ever see a squad's generated name; the name a squad picked is shown to its own members.
 *
 * Until 0017 has been applied every function answers "being set up" instead of failing.
 */

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;
const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

export type SquadResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };
const SETUP = { ok: false as const, status: 503, error: "Squads are being set up. Try again soon." };

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SQUAD.codeLength));
  return Array.from(bytes, (b) => SQUAD_CODE_ALPHABET[b % SQUAD_CODE_ALPHABET.length]).join("");
}

type Membership = { squad_id: string; name: string; code: string; owner_user_id: string };

async function membershipOf(userId: string): Promise<Membership | null> {
  return (
    rowsOf<Membership>(
      await db.execute(sql`
        select s.id as squad_id, s.name, s.code, s.owner_user_id
        from shar_squad_members m join shar_squads s on s.id = m.squad_id where m.user_id = ${userId}`),
    )[0] ?? null
  );
}

/** The squad screen: the person's squad (if any) with each member's week and the goal, plus this week's board of squads. */
export async function getSquadView(userId: string, now: Date = new Date()) {
  const week = weekStartUtc(now);
  let mine: Membership | null;
  try {
    mine = await membershipOf(userId);
  } catch (err) {
    if (isMissingTable(err)) return { ready: false as const, squad: null, board: [], rules: rulesOut(), weekEndsAt: nextWeekStartUtc(now).toISOString() };
    throw err;
  }

  let squad = null;
  if (mine) {
    const ids = rowsOf<{ user_id: string }>(await db.execute(sql`select user_id from shar_squad_members where squad_id = ${mine.squad_id} order by joined_at asc`)).map((r) => r.user_id);
    const totals = new Map((await weeklyTotals({ from: week }, { userIds: ids, limit: SQUAD.maxMembers })).map((r) => [r.user_id, r.shar]));
    const members = (
      await Promise.all(ids.map(async (id) => ({ handle: await handleFor(id), you: id === userId, owner: id === mine.owner_user_id, shar: totals.get(id) ?? 0 })))
    ).sort((a, b) => b.shar - a.shar || Number(b.you) - Number(a.you));
    const weekShar = members.reduce((sum, m) => sum + m.shar, 0);
    squad = {
      name: mine.name,
      code: mine.code,
      isOwner: mine.owner_user_id === userId,
      memberCount: ids.length,
      full: ids.length >= SQUAD.maxMembers,
      members,
      ...squadProgress(weekShar, ids.length),
    };
  }

  // This week's squads by total (only squads that have earned something), named by their generated handle.
  const ranked = await withWeekly({ from: week }, async (cte) =>
    rowsOf<{ squad_id: string; shar: number; members: number }>(
      await db.execute(sql`
        with ${cte}
        select m.squad_id, sum(w.shar)::int as shar, (select count(*) from shar_squad_members x where x.squad_id = m.squad_id)::int as members
        from weekly w join shar_squad_members m on m.user_id = w.user_id
        group by m.squad_id order by shar desc, m.squad_id asc limit 200`),
    ),
  );
  const board = await Promise.all(
    ranked.slice(0, SQUAD.boardSize).map(async (r, i) => ({
      rank: i + 1,
      name: await squadHandle(r.squad_id),
      shar: num(r.shar),
      members: num(r.members),
      you: r.squad_id === mine?.squad_id,
      reached: squadProgress(num(r.shar), num(r.members)).reached,
    })),
  );
  const myIdx = mine ? ranked.findIndex((r) => r.squad_id === mine.squad_id) : -1;
  return {
    ready: true as const,
    squad,
    board,
    myRank: myIdx >= 0 ? myIdx + 1 : null,
    rules: rulesOut(),
    weekEndsAt: nextWeekStartUtc(now).toISOString(),
  };
}

function rulesOut() {
  return { maxMembers: SQUAD.maxMembers, goalPerMember: SQUAD.goalPerMember, minGoal: SQUAD.minGoal, nameMin: SQUAD.nameMin, nameMax: SQUAD.nameMax, codeLength: SQUAD.codeLength };
}

/** Starts a squad with the person as its first member. */
export async function createSquad(userId: string, rawName: unknown): Promise<SquadResult<{ code: string }>> {
  const name = cleanSquadName(rawName);
  if (!name) return { ok: false, status: 400, error: `Give your squad a name of ${SQUAD.nameMin} to ${SQUAD.nameMax} letters or numbers, with no links.` };
  try {
    if (await membershipOf(userId)) return { ok: false, status: 409, error: "You're already in a squad. Leave it first to start another." };
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      let id: string;
      try {
        id = rowsOf<{ id: string }>(await db.execute(sql`insert into shar_squads (name, code, owner_user_id) values (${name}, ${code}, ${userId}) returning id`))[0].id;
      } catch (err) {
        if (isUniqueViolation(err)) continue; // a code clash: try another
        throw err;
      }
      try {
        await db.execute(sql`insert into shar_squad_members (user_id, squad_id, slot) values (${userId}, ${id}::uuid, 1)`);
        return { ok: true, code };
      } catch (err) {
        await db.execute(sql`delete from shar_squads where id = ${id}::uuid`).catch(() => {});
        if (isUniqueViolation(err)) return { ok: false, status: 409, error: "You're already in a squad. Leave it first to start another." };
        throw err;
      }
    }
    return { ok: false, status: 500, error: "Couldn't make a squad code. Try again." };
  } catch (err) {
    if (isMissingTable(err)) return SETUP;
    throw err;
  }
}

/** Joins the squad with this code. The lowest free slot is taken, and the unique (squad, slot) is what keeps a squad to ten even under a race. */
export async function joinSquad(userId: string, rawCode: unknown): Promise<SquadResult> {
  const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
  if (!isSquadCode(code)) return { ok: false, status: 400, error: "That squad code isn't valid." };
  try {
    const found = rowsOf<{ id: string }>(await db.execute(sql`select id from shar_squads where code = ${code}`))[0];
    if (!found) return { ok: false, status: 404, error: "That squad code isn't valid." };
    if (await membershipOf(userId)) return { ok: false, status: 409, error: "You're already in a squad. Leave it first to join another." };
    // Each failed try means someone else took that slot a moment ago; the next try picks the next free one, so a squad can be filled in one rush.
    for (let attempt = 0; attempt < SQUAD.maxMembers + 2; attempt++) {
      const slot = rowsOf<{ s: number }>(
        await db.execute(sql`
          select g as s from generate_series(1, ${SQUAD.maxMembers}) g
          where g not in (select slot from shar_squad_members where squad_id = ${found.id}::uuid) order by g limit 1`),
      )[0]?.s;
      if (!slot) return { ok: false, status: 409, error: "That squad is full." };
      try {
        await db.execute(sql`insert into shar_squad_members (user_id, squad_id, slot) values (${userId}, ${found.id}::uuid, ${slot})`);
        return { ok: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Either this person just joined elsewhere (two taps), or someone took the same slot a moment ago: look again.
        if (await membershipOf(userId)) return { ok: false, status: 409, error: "You're already in a squad. Leave it first to join another." };
      }
    }
    return { ok: false, status: 409, error: "That squad is full." };
  } catch (err) {
    if (isMissingTable(err)) return SETUP;
    throw err;
  }
}

/** Leaves the squad. The last person out closes it; if the owner leaves, the longest-standing member takes over. */
export async function leaveSquad(userId: string): Promise<SquadResult> {
  try {
    const mine = await membershipOf(userId);
    if (!mine) return { ok: false, status: 404, error: "You're not in a squad." };
    await db.execute(sql`delete from shar_squad_members where user_id = ${userId}`);
    const left = rowsOf<{ user_id: string }>(await db.execute(sql`select user_id from shar_squad_members where squad_id = ${mine.squad_id}::uuid order by joined_at asc`));
    if (left.length === 0) await db.execute(sql`delete from shar_squads where id = ${mine.squad_id}::uuid`);
    else if (mine.owner_user_id === userId) await db.execute(sql`update shar_squads set owner_user_id = ${left[0].user_id} where id = ${mine.squad_id}::uuid`);
    return { ok: true };
  } catch (err) {
    if (isMissingTable(err)) return SETUP;
    throw err;
  }
}
