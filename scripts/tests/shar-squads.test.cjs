/**
 * Squads: the pure rules (names, goals, codes), then the real flow on a real Postgres engine (PGlite) built from the real migrations:
 * creating, joining, the ten-person cap, leaving and handing over, the weekly pool and goal, the board of squads, and what happens
 * before the migration has been applied.
 *
 *     node scripts/tests/shar-squads.test.cjs
 */
const fs = require("fs");
const path = require("path");
const { PGlite, makeLoader, reporter, req, migrations } = require("./_harness.cjs");
const { check, finish } = reporter();
const { drizzle: drizzleProxy } = req("drizzle-orm/pg-proxy");

const drizzle = (client, opts) =>
  drizzleProxy(async (query, params, method) => ({ rows: (await client.query(query, params, method === "all" ? { rowMode: "array" } : undefined)).rows }), opts);

const schema = makeLoader({})("src/lib/db/schema.ts");
const rules = makeLoader({})("src/lib/shar-squad-rules.ts");
const PAYMENTS_SQL = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;

async function freshDb({ migrate = true } = {}) {
  const client = new PGlite();
  await client.exec(PAYMENTS_SQL);
  if (migrate) for (const stmt of migrations.statements) await client.exec(stmt);
  const db = drizzle(client, { schema });
  const load = makeLoader({ "@/lib/db": { db }, "@/lib/server-env": { getServerEnv: () => undefined } });
  return { client, squads: load("src/lib/shar-squads.ts"), shar: load("src/lib/shar.ts") };
}

const NOW = new Date("2026-10-07T12:00:00Z"); // Wednesday; the week began Monday 2026-10-05
const spend = (c, user, usd, when = "2026-10-06 09:00:00") =>
  c.query("insert into payments (user_id,type,status,amount_usdc,description,created_at) values ($1,'bill','completed',$2,'Netflix',$3)", [user, String(usd), when]);

(async () => {
  // ── pure rules
  const R = rules;
  check("goal: 100 at least, then 50 Shar per member", R.squadGoal(1) === 100 && R.squadGoal(2) === 100 && R.squadGoal(3) === 150 && R.squadGoal(10) === 500 && R.squadGoal(0) === 100);
  const pr = R.squadProgress(130, 3);
  check("progress: 130 of 150 is 87%, not reached, 20 to go; at or over the goal it is reached", Math.abs(pr.progress - 130 / 150) < 1e-9 && !pr.reached && pr.remaining === 20 && R.squadProgress(150, 3).reached && R.squadProgress(900, 3).progress === 1 && R.squadProgress(900, 3).remaining === 0);
  check("names: letters, digits and a little punctuation are fine, tidied up", R.cleanSquadName("  Lagos   Seekers! ") === "Lagos Seekers!" && R.cleanSquadName("Team 9") === "Team 9" && R.cleanSquadName("Ọmọ Èkó") === "Ọmọ Èkó" && R.cleanSquadName("Cool-Cats & Co") === "Cool-Cats & Co");
  check("names: too short, too long, links, emails, handles and symbols are refused", ["a", "x".repeat(25), "visit bluvfi.xyz", "https://x", "www.thing", "me@mail", "join t.me/abc", "my discord", "<b>hi</b>", "💰💰", 5, null, undefined].every((n) => R.cleanSquadName(n) === null));
  check("codes: six characters from the no-lookalike alphabet", R.isSquadCode("ABC234") && !R.isSquadCode("ABC23") && !R.isSquadCode("ABC2340") && !R.isSquadCode("abc234") && !R.isSquadCode("ABCO12") && !R.isSquadCode(7));
  const h1 = await R.squadHandle("11111111-1111-1111-1111-111111111111");
  check("a squad's public name is made from its id, the same every time, and never from anything typed", /^Squad [0-9A-F]{4}$/.test(h1) && h1 === (await R.squadHandle("11111111-1111-1111-1111-111111111111")) && h1 !== (await R.squadHandle("22222222-2222-2222-2222-222222222222")));
  check("the invite text carries the squad name and the code, and says where to enter it", R.squadInviteMessage("Lagos Seekers", "ABC234").includes("ABC234") && R.squadInviteMessage("Lagos Seekers", "ABC234").includes("Lagos Seekers") && /Daily Spark/.test(R.squadInviteMessage("x y", "ABC234")));

  // ── creating, joining, leaving
  const { client, squads, shar } = await freshDb();
  const made = await squads.createSquad("a", "  Lagos   Seekers ");
  check("create: the squad is made with a code and the person as its owner and first member", made.ok && R.isSquadCode(made.code), JSON.stringify(made));
  const again = await squads.createSquad("a", "Another");
  check("create: someone already in a squad can't start another", !again.ok && again.status === 409);
  const badName = await squads.createSquad("b", "see my site www.x.com");
  check("create: a name with a link is refused (400), and nothing is created for it", !badName.ok && badName.status === 400 && (await client.query("select count(*)::int as n from shar_squads")).rows[0].n === 1);
  const code = made.code;
  const joinB = await squads.joinSquad("b", code.toLowerCase());
  check("join: a friend joins with the code, in any case", joinB.ok);
  check("join: joining twice, or a second squad, is refused", !(await squads.joinSquad("b", code)).ok && (await squads.joinSquad("b", code)).status === 409);
  const wrong = await squads.joinSquad("c", "ZZZZZZ");
  check("join: an unknown code is a 404 and a malformed one a 400", !wrong.ok && wrong.status === 404 && (await squads.joinSquad("c", "nope")).status === 400);
  // fill it, and a rush for the last places
  const rush = await Promise.all(Array.from({ length: 11 }, (_, i) => squads.joinSquad(`m${i}`, code)));
  const inSquad = (await client.query("select count(*)::int as n from shar_squad_members")).rows[0].n;
  check("cap: twelve people at the door of a squad that has two places taken still ends at ten, and the rest are told it's full", inSquad === 10 && rush.filter((r) => r.ok).length === 8 && rush.filter((r) => !r.ok && /full/.test(r.error)).length === 3, `${inSquad} members, ${rush.filter((r) => r.ok).length} in`);
  const slots = (await client.query("select slot from shar_squad_members order by slot")).rows.map((r) => r.slot);
  check("cap: every member has their own slot from 1 to 10", slots.join() === "1,2,3,4,5,6,7,8,9,10");
  const dup = await client.query("insert into shar_squad_members (user_id, squad_id, slot) select 'zz', squad_id, 3 from shar_squad_members limit 1").then(() => false, () => true);
  check("cap: the database itself refuses an eleventh member or a taken slot", dup);

  // ── the week's pool
  await spend(client, "a", 40);
  await spend(client, "b", 30);
  await spend(client, "m0", 100, "2026-09-30 10:00:00"); // last week: not counted
  await client.query("insert into shar_sparks (user_id, day, shar, streak) values ('m1', '2026-10-06', 3, 3)");
  const view = await squads.getSquadView("a", NOW);
  check("view: the squad's week is its members' Shar this week (purchases and sparks, not last week's)", view.ready && view.squad.shar === 73 && view.squad.memberCount === 10, String(view.squad && view.squad.shar));
  check("view: the goal is 50 per member (500 for ten), so 73 is not there yet and 427 remain", view.squad.goal === 500 && !view.squad.reached && view.squad.remaining === 427 && Math.abs(view.squad.progress - 73 / 500) < 1e-9);
  check("view: members are shown by anonymous handle with the person marked 'you' and the biggest first", view.squad.members[0].shar === 40 && view.squad.members[0].you === true && view.squad.members.every((m) => /^Seeker [0-9A-F]{4}$/.test(m.handle)) && view.squad.members.filter((m) => m.you).length === 1);
  check("view: the owner sees their squad's own name and code, other members see the name too, and 'owner' is marked once", view.squad.name === "Lagos Seekers" && view.squad.code === code && view.squad.isOwner && view.squad.members.filter((m) => m.owner).length === 1 && view.squad.full === true);
  const viewB = await squads.getSquadView("b", NOW);
  check("view: a non-owner member sees the same squad and is not marked owner", viewB.squad.name === "Lagos Seekers" && !viewB.squad.isOwner);
  await spend(client, "m2", 500);
  const done = await squads.getSquadView("a", NOW);
  check("goal: once the pool passes it the squad has reached it", done.squad.reached && done.squad.remaining === 0 && done.squad.progress === 1);

  // ── the board of squads: strangers only ever see generated names
  const second = await squads.createSquad("x1", "Rival crew");
  await squads.joinSquad("x2", second.code);
  await spend(client, "x1", 120);
  await spend(client, "x2", 20);
  const bd = (await squads.getSquadView("x1", NOW)).board;
  check("board: squads are ranked by this week's pool, each shown by a generated name", bd.length === 2 && bd[0].shar === 573 && bd[1].shar === 140 && bd.every((e) => /^Squad [0-9A-F]{4}$/.test(e.name)), JSON.stringify(bd));
  check("board: the custom names are not on it (nothing a person typed reaches strangers)", !JSON.stringify(bd).includes("Lagos") && !JSON.stringify(bd).includes("Rival"));
  check("board: your own squad is marked, with its rank, and the goal state per squad is shown", bd[1].you === true && (await squads.getSquadView("x1", NOW)).myRank === 2 && bd[0].reached === true && bd[1].reached === true && bd[0].members === 10 && bd[1].members === 2);
  const lone = await squads.getSquadView("nobody", NOW);
  check("view: someone in no squad sees no squad, the board, and the rules to start one", lone.ready && lone.squad === null && lone.board.length === 2 && lone.rules.maxMembers === 10 && lone.myRank === null);

  // ── leaving
  check("leave: not being in a squad is a 404", (await squads.leaveSquad("nobody")).status === 404);
  const ownerLeaves = await squads.leaveSquad("a");
  const ownerNow = (await client.query("select owner_user_id from shar_squads where code = $1", [code])).rows[0].owner_user_id;
  check("leave: when the owner leaves, the longest-standing member becomes owner, and the squad carries on", ownerLeaves.ok && ownerNow === "b" && (await squads.getSquadView("b", NOW)).squad.memberCount === 9 && (await squads.getSquadView("b", NOW)).squad.isOwner);
  check("leave: a person who left can join another squad", (await squads.joinSquad("a", second.code)).ok);
  await squads.leaveSquad("x1");
  await squads.leaveSquad("x2");
  await squads.leaveSquad("a");
  check("leave: when the last person leaves the squad is closed", (await client.query("select count(*)::int as n from shar_squads where code = $1", [second.code])).rows[0].n === 0);

  // ── the summary and the badge
  const sum = await shar.getSummary("b", NOW);
  check("summary: being in a squad earns the Squad badge (and others don't have it)", sum.badges.find((b) => b.key === "squad_member").earned && !(await shar.getSummary("nobody", NOW)).badges.find((b) => b.key === "squad_member").earned);

  // ── before the migration has been applied
  const old = await freshDb();
  await old.client.exec("drop table shar_squad_members; drop table shar_squads;");
  const oldView = await old.squads.getSquadView("a", NOW);
  const oldCreate = await old.squads.createSquad("a", "Lagos Seekers");
  const oldJoin = await old.squads.joinSquad("a", "ABC234");
  const oldSummary = await old.shar.getSummary("a", NOW);
  check("no table yet: the squad view says it isn't ready, create and join say 'being set up' (503), and Shar itself still loads", oldView.ready === false && oldView.squad === null && !oldCreate.ok && oldCreate.status === 503 && !oldJoin.ok && oldJoin.status === 503 && oldSummary.ready === true);

  // ── the route and the migration
  const route = fs.readFileSync(path.join(__dirname, "../../src/app/api/shar/squad/route.ts"), "utf8");
  check("route: sign-in required and rate limited for both reading and writing, with exactly the three actions", route.includes("verifyAuth") && (route.match(/checkApiLimit/g) || []).length >= 2 && ["create", "join", "leave"].every((a) => route.includes(`"${a}"`)));
  const sql = fs.readFileSync(path.join(__dirname, "../../drizzle/0017_squads_awards_push.sql"), "utf8");
  check("migration: safe to run twice, with the slot cap and one squad per person enforced by the database", (sql.match(/IF NOT EXISTS/g) || []).length >= 7 && sql.includes('"user_id" text PRIMARY KEY') && sql.includes("BETWEEN 1 AND 10") && sql.includes('UNIQUE ("squad_id", "slot")') && sql.includes('PRIMARY KEY ("week_start", "user_id")'));

  finish();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
