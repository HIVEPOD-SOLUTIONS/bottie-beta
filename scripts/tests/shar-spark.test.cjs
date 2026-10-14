/**
 * Daily Spark, Shar badges, the weekly board with sparks, and the server-side Seeker Genesis Token check: the pure rules, then the
 * real flow on a real Postgres engine (PGlite) built from the real migrations.
 *
 *     node scripts/tests/shar-spark.test.cjs
 */
const fs = require("fs");
const path = require("path");
const { PGlite, makeLoader, reporter, req, migrations } = require("./_harness.cjs");
const { check, finish } = reporter();
const { drizzle: drizzleProxy } = req("drizzle-orm/pg-proxy");

const drizzle = (client, opts) =>
  drizzleProxy(async (query, params, method) => ({ rows: (await client.query(query, params, method === "all" ? { rowMode: "array" } : undefined)).rows }), opts);

const schema = makeLoader({})("src/lib/db/schema.ts");
const rules = makeLoader({})("src/lib/shar-spark-rules.ts");
const sharRules = makeLoader({})("src/lib/shar-rules.ts");
const PAYMENTS_SQL = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;

const holders = new Set(); // who the stubbed Seeker check says holds a Seeker Genesis Token

async function freshDb({ sparksTable = true, realFromWeek = false } = {}) {
  const client = new PGlite();
  await client.exec(PAYMENTS_SQL);
  for (const stmt of migrations.statements) await client.exec(stmt);
  if (!sparksTable) await client.exec("drop table shar_sparks");
  const db = drizzle(client, { schema });
  const load = makeLoader({
    "@/lib/db": { db },
    "@/lib/server-env": { getServerEnv: () => undefined },
    "@/lib/seeker-sgt": { isSeekerHolder: async (u) => holders.has(u) },
  });
  // The fixtures here are weeks in September and early October, before prizes began, so open the window for them (one test keeps the real date).
  if (!realFromWeek) load("src/lib/shar-spark-rules.ts").WEEKLY_PRIZE_FROM_WEEK = "2000-01-01";
  return { client, load, shar: load("src/lib/shar.ts") };
}

const at = (iso) => new Date(`${iso}T12:00:00Z`);

(async () => {
  // ── the pure rules
  const R = rules;
  const pay = (streak, seeker = false) => R.sparkReward(streak, seeker).shar;
  check("rewards: days 1 and 2 pay 2, days 3 to 6 pay 3, day 7 pays 4 plus the 10 bonus", pay(1) === 2 && pay(2) === 2 && pay(3) === 3 && pay(6) === 3 && pay(7) === 14);
  check("rewards: after day 7 the streak stays at 4 a day, and each 7th day adds the bonus again", pay(8) === 4 && pay(13) === 4 && pay(14) === 14 && pay(21) === 14 && pay(15) === 4);
  check("rewards: a Seeker holder gets 1.5x on the day and on the bonus, with whole Shar only", pay(1, true) === 3 && pay(3, true) === 4 && pay(7, true) === 21 && pay(14, true) === 21);
  check("rewards: nothing ever pays a fraction or less than 1", [...Array(60).keys()].every((i) => [false, true].every((s) => Number.isInteger(pay(i + 1, s)) && pay(i + 1, s) >= 1)));
  check("rewards: the weekly ceiling is 38 Shar (57 for a holder), the figure to budget SKR against", R.maxSparkPerWeek(false) === 38 && R.maxSparkPerWeek(true) === 57, `${R.maxSparkPerWeek(false)} / ${R.maxSparkPerWeek(true)}`);
  check("days: sparkDay is the UTC day; dayBefore crosses months and years", R.sparkDay(new Date("2026-10-07T23:59:59Z")) === "2026-10-07" && R.sparkDay(new Date("2026-10-08T00:00:00Z")) === "2026-10-08" && R.dayBefore("2026-10-01") === "2026-09-30" && R.dayBefore("2027-01-01") === "2026-12-31" && R.dayBefore("2028-03-01") === "2028-02-29");
  check("days: the next spark comes at the coming 00:00 UTC", R.nextSparkAt(new Date("2026-10-07T18:30:00Z")).toISOString() === "2026-10-08T00:00:00.000Z");
  const last = { day: "2026-10-06", streak: 4 };
  check("streak: alive today if collected yesterday, still 4; collecting makes 5", R.liveStreak(last, "2026-10-07").streak === 4 && !R.liveStreak(last, "2026-10-07").collectedToday && R.streakAfterCollecting(last, "2026-10-07") === 5);
  check("streak: collected today keeps its streak and does not go up again", R.liveStreak({ day: "2026-10-07", streak: 5 }, "2026-10-07").collectedToday && R.streakAfterCollecting({ day: "2026-10-07", streak: 5 }, "2026-10-07") === 5);
  check("streak: a missed day (two days ago) resets it to 0, and collecting starts at 1; no history starts at 1", R.liveStreak({ day: "2026-10-05", streak: 9 }, "2026-10-07").streak === 0 && R.streakAfterCollecting({ day: "2026-10-05", streak: 9 }, "2026-10-07") === 1 && R.streakAfterCollecting(null, "2026-10-07") === 1);
  check("days: a made-up day string is rejected", R.isDay("2026-10-07") && !R.isDay("2026-13-45") && !R.isDay("tomorrow") && !R.isDay(5));
  check("prizes: set to 50, 30 and 20 Shar (100 a week at most, 90 SKR), with a 20 Shar minimum to win one", JSON.stringify(R.WEEKLY_PRIZE_SHAR) === "[50,30,20]" && R.WEEKLY_PRIZE_MIN_SHAR === 20 && R.WEEKLY_PRIZE_SHAR.reduce((a, b) => a + b, 0) === 100);
  const none = { sparks: 0, bestStreak: 0, purchases: 0, referred: 0, providersOwned: 0, claims: 0, seeker: false, inSquad: false };
  check("badges: none earned with nothing done, and each one needs its own thing", R.badgesFor(none).every((b) => !b.earned) && R.badgesFor(none).length === 9);
  const got = (facts) => R.badgesFor({ ...none, ...facts }).filter((b) => b.earned).map((b) => b.key).join();
  check("badges: first spark, 7 and 30 day streaks, purchase, companion, provider, claim and Seeker each unlock separately", got({ sparks: 1 }) === "first_spark" && got({ bestStreak: 7 }) === "streak_7" && got({ bestStreak: 30 }) === "streak_7,streak_30" && got({ purchases: 1 }) === "first_purchase" && got({ referred: 1 }) === "first_companion" && got({ providersOwned: 1 }) === "first_provider" && got({ claims: 1 }) === "first_claim" && got({ inSquad: true }) === "squad_member" && got({ seeker: true }) === "seeker_holder");

  // ── collecting
  const { client, shar } = await freshDb();
  const A = "user-a";
  const first = await shar.collectSpark(A, at("2026-10-05"));
  check("collect: the first spark pays 2 Shar and starts a streak of 1", first.ok && first.shar === 2 && first.streak === 1 && !first.seeker, JSON.stringify(first));
  const again = await shar.collectSpark(A, at("2026-10-05"));
  check("collect: a second spark the same day is refused (409) and pays nothing", !again.ok && again.status === 409);
  const day2 = await shar.collectSpark(A, at("2026-10-06"));
  check("collect: the next day the streak is 2", day2.ok && day2.streak === 2 && day2.shar === 2);
  const day3 = await shar.collectSpark(A, at("2026-10-07"));
  check("collect: day 3 steps up to 3 Shar", day3.ok && day3.streak === 3 && day3.shar === 3);
  const rows = (await client.query("select count(*)::int as n, sum(shar)::int as total from shar_sparks where user_id = $1", [A])).rows[0];
  check("collect: exactly three rows and 7 Shar stored", rows.n === 3 && rows.total === 7, JSON.stringify(rows));

  // two taps at once pay once
  const B = "user-b";
  const both = await Promise.all([shar.collectSpark(B, at("2026-10-07")), shar.collectSpark(B, at("2026-10-07"))]);
  check("collect: two taps at the same moment pay exactly once", both.filter((r) => r.ok).length === 1 && both.filter((r) => !r.ok && r.status === 409).length === 1);

  // a missed day resets
  const C = "user-c";
  await shar.collectSpark(C, at("2026-10-01"));
  await shar.collectSpark(C, at("2026-10-02"));
  const afterGap = await shar.collectSpark(C, at("2026-10-04"));
  check("collect: skipping a day starts the streak again at 1", afterGap.ok && afterGap.streak === 1 && afterGap.shar === 2);

  // the 7th day bonus
  const D = "user-d";
  let seventh;
  for (let i = 1; i <= 7; i++) seventh = await shar.collectSpark(D, at(`2026-10-0${i}`));
  check("collect: the 7th day in a row pays 4 plus the 10 bonus", seventh.ok && seventh.streak === 7 && seventh.shar === 14 && seventh.bonus === 10, JSON.stringify(seventh));

  // Seeker holder
  const E = "user-e";
  holders.add(E);
  const seeker = await shar.collectSpark(E, at("2026-10-05"));
  check("seeker: a verified holder gets the 1.5x multiplier and is recorded as one", seeker.ok && seeker.shar === 3 && seeker.seeker === true && (await client.query("select seeker from shar_sparks where user_id=$1", [E])).rows[0].seeker === true);
  const nonHolder = (await client.query("select seeker from shar_sparks where user_id=$1", [A])).rows[0];
  check("seeker: someone who does not hold one is not marked as a holder", nonHolder.seeker === false);

  // device guard: a second account on the same phone gets nothing the same day
  await client.query("insert into user_devices (user_id, device_hash) values ('user-f', 'phone-1'), ('user-g', 'phone-1')");
  const f1 = await shar.collectSpark("user-f", at("2026-10-07"));
  const g1 = await shar.collectSpark("user-g", at("2026-10-07"));
  const g2 = await shar.collectSpark("user-g", at("2026-10-08"));
  check("phone: the first account on a phone collects, a second account the same day does not, but can the next day", f1.ok && !g1.ok && g1.status === 409 && g2.ok);

  // ── the summary
  const NOW = at("2026-10-07"); // Wednesday; the week began Monday 2026-10-05
  const sum = await shar.getSummary(A, NOW);
  check("summary: sparks count as available Shar, lifetime and this week", sum.available === 7 && sum.lifetime === 7 && sum.week === 7, `${sum.available}/${sum.lifetime}/${sum.week}`);
  check("summary: the streak is live at 3, today's is collected, tomorrow's will be worth 3 (day 4)", sum.spark.streak === 3 && sum.spark.collectedToday && sum.spark.next.streak === 4 && sum.spark.next.shar === 3);
  check("summary: the week strip has 7 days ending today, with the three collected ones marked", sum.spark.days.length === 7 && sum.spark.days[6].today && sum.spark.days.filter((d) => d.collected).length === 3 && sum.spark.days[6].day === "2026-10-07");
  check("summary: the next spark time is midnight UTC", sum.spark.nextAt === "2026-10-08T00:00:00.000Z");
  check("summary: the log lists the sparks", sum.activity.filter((a) => a.kind === "spark").length === 3 && sum.activity.some((a) => a.title === "Daily Spark · day 3"));
  check("summary: badges show First Spark earned and the rest not (no streak of 7, no purchase)", sum.badges.find((b) => b.key === "first_spark").earned && !sum.badges.find((b) => b.key === "streak_7").earned && !sum.badges.find((b) => b.key === "seeker_holder").earned);
  check("summary: sparks do not flip `ready`, so claims stay available", sum.ready === true && sum.spark.ready === true);
  const dSum = await shar.getSummary(D, at("2026-10-07"));
  check("summary: a finished 7 day streak earns the 7-day badge", dSum.badges.find((b) => b.key === "streak_7").earned);
  const eSum = await shar.getSummary(E, NOW);
  check("summary: a Seeker holder gets the Seeker Genesis badge and a bigger next reward (3, not 2, since the streak lapsed)", eSum.badges.find((b) => b.key === "seeker_holder").earned && eSum.spark.seeker === true && eSum.spark.next.shar === 3, JSON.stringify(eSum.spark.next));
  await client.query("insert into payments (user_id,type,status,amount_usdc,description,created_at) values ($1,'bill','completed','25','Netflix','2026-10-06 10:00:00')", [A]);
  check("summary: a completed purchase earns the First purchase badge", (await shar.getSummary(A, NOW)).badges.find((b) => b.key === "first_purchase").earned);
  const idle = await shar.getSummary("nobody", NOW);
  check("summary: someone with no sparks has streak 0, nothing collected, and the first reward is 2", idle.spark.streak === 0 && !idle.spark.collectedToday && idle.spark.next.shar === 2 && idle.available === 0);
  const lateSum = await shar.getSummary(A, at("2026-10-09"));
  check("summary: after two missed days the streak shows 0 again (but the Shar stays)", lateSum.spark.streak === 0 && lateSum.available === 32 /* 7 sparks + 25 purchase */);

  // ── the weekly board
  const board = await shar.getLeaderboard(A, NOW);
  const mine = board.top.find((r) => r.you);
  check("board: sparks count toward the weekly board and the person is ranked", !!mine && mine.shar === 7 + 25 && board.me.rank !== null, JSON.stringify(board.top.slice(0, 3)));
  check("board: the Seeker holder is marked, others are not", board.top.find((r) => r.seeker) && board.top.filter((r) => r.seeker).length === 1);
  check("board: the prizes are listed, and only the top three with at least 20 Shar are marked as on course for one", board.prizes.length === 3 && board.top.every((r, i) => r.prizeShar === ([50, 30, 20][i] !== undefined && r.shar >= 20 ? [50, 30, 20][i] : null)) && board.top.filter((r) => r.prizeShar).length >= 1);
  const nextWeek = await shar.getLeaderboard(A, at("2026-10-13"));
  check("board: it resets on Monday, so last week's sparks are gone", nextWeek.top.length === 0 || nextWeek.me.shar === 0);

  // ── weekly prizes, at the REAL amounts (50, 30, 20): nothing is patched for these checks
  {
    const p = await freshDb();
    const lastWeek = "2026-09-30 10:00:00"; // the week of Mon 2026-09-28; NOW is Wed 2026-10-07, so the week of 10-05 is current
    const buy = (db, u, usd, when, status = "completed") => db.client.query("insert into payments (user_id,type,status,amount_usdc,description,created_at) values ($1,'bill',$2,$3,'Netflix',$4)", [u, status, String(usd), when]);
    await buy(p, "p1", 200, lastWeek);
    await buy(p, "p2", 100, lastWeek);
    await buy(p, "p3", 60, lastWeek);
    await buy(p, "p6", 40, lastWeek); // fourth: there is no fourth prize
    await buy(p, "p7", 12, lastWeek); // under the 10 dollar purchase minimum, so no Shar at all
    await buy(p, "p4", 300, "2026-10-06 09:00:00"); // this week: must not count for last week
    await buy(p, "p5", 500, lastWeek, "pending"); // not completed: must not count
    const [a1, b1, c1] = await Promise.all([p.shar.getSummary("p1", NOW), p.shar.getSummary("p2", NOW), p.shar.getSummary("p1", NOW)]);
    const awards = (await p.client.query("select user_id, place, shar, to_char(week_start,'YYYY-MM-DD') as wk from shar_weekly_awards order by place")).rows;
    check("prizes: last week's top three are paid 50, 30 and 20 Shar, in order, for that week", awards.length === 3 && awards.map((r) => r.user_id).join() === "p1,p2,p3" && awards.map((r) => r.shar).join() === "50,30,20" && awards.map((r) => r.place).join() === "1,2,3" && awards.every((r) => r.wk === "2026-09-28"), JSON.stringify(awards));
    check("prizes: fourth place and below win nothing, and neither do this week's purchases or a payment that isn't completed", !awards.some((r) => ["p4", "p5", "p6", "p7"].includes(r.user_id)));
    check("prizes: three people loading at the same moment still pay each place once, and the whole week costs 100 Shar at most", awards.length === 3 && awards.reduce((s, r) => s + r.shar, 0) === 100);
    check("prizes: the prize is real Shar, counted in the balance and the rank (200 spent + 50 prize)", a1.available === 250 && a1.lifetime === 250 && c1.available === 250 && b1.available === 130, `${a1.available}/${b1.available}`);
    check("prizes: it shows in the journey log as the weekly trial place, and is worth 45 SKR at the fixed rate", a1.activity.some((x) => x.kind === "prize" && x.title === "Weekly trial · place #1" && x.shar === 50) && sharRules.skrForShar(50) === "45" && sharRules.skrForShar(30) === "27" && sharRules.skrForShar(20) === "18");
    await p.shar.getSummary("p1", NOW);
    check("prizes: loading again pays nothing more", (await p.client.query("select count(*)::int as n from shar_weekly_awards")).rows[0].n === 3);
    const later = await p.shar.getSummary("p4", new Date("2026-10-14T12:00:00Z"));
    check("prizes: the next week settles the week after it (p4's 300 Shar from Oct 6 wins first place) and doesn't pay the old week again", (await p.client.query("select count(*)::int as n from shar_weekly_awards where week_start = '2026-09-28'")).rows[0].n === 3 && (await p.client.query("select shar from shar_weekly_awards where user_id = 'p4' and week_start = '2026-10-05'")).rows[0]?.shar === 50 && later.available === 350);
    const pb = await p.shar.getLeaderboard("p4", NOW);
    check("prizes: the board lists 50, 30 and 20 (and what they are in SKR), the minimum, and who is on course for the first", pb.prizes.map((x) => x.shar).join() === "50,30,20" && pb.prizes.map((x) => x.skr).join() === "45,27,18" && pb.prizeMinShar === 20 && pb.top[0].prizeShar === 50 && pb.top[0].shar === 300);
    const lowDb = await freshDb();
    await buy(lowDb, "w1", 200, lastWeek);
    await buy(lowDb, "w2", 100, lastWeek);
    await lowDb.client.query("insert into shar_sparks (user_id, day, shar, streak) values ('w3', '2026-09-30', 15, 1)");
    await lowDb.shar.getSummary("w1", NOW);
    check("prizes: a third place that earned under 20 Shar that week wins nothing (here 15)", (await lowDb.client.query("select user_id from shar_weekly_awards order by place")).rows.map((r) => r.user_id).join() === "w1,w2");
    const tieDb = await freshDb();
    await buy(tieDb, "t2", 100, lastWeek);
    await buy(tieDb, "t1", 100, lastWeek);
    await buy(tieDb, "t3", 100, lastWeek);
    await buy(tieDb, "t4", 100, lastWeek);
    await tieDb.shar.getSummary("t1", NOW);
    check("prizes: a tie is settled the same way every time (by id), so the same people win however many times it is calculated", (await tieDb.client.query("select user_id, shar from shar_weekly_awards order by place")).rows.map((r) => r.user_id + ":" + r.shar).join() === "t1:50,t2:30,t3:20");
    const sparkDb = await freshDb();
    await sparkDb.client.query("insert into shar_sparks (user_id, day, shar, streak) values ('s1', '2026-09-29', 30, 7)");
    await buy(sparkDb, "s2", 25, lastWeek);
    await sparkDb.shar.getSummary("s1", NOW);
    check("prizes: Daily Sparks count toward the week like any other Shar", (await sparkDb.client.query("select user_id from shar_weekly_awards order by place")).rows.map((r) => r.user_id).join() === "s1,s2");
    const retro = await freshDb({ realFromWeek: true });
    await buy(retro, "r1", 200, "2026-10-06 10:00:00"); // the week of Oct 5, before prizes began
    await retro.shar.getSummary("r1", new Date("2026-10-14T12:00:00Z"));
    const before = (await retro.client.query("select count(*)::int as n from shar_weekly_awards")).rows[0].n;
    await buy(retro, "r1", 200, "2026-10-14 10:00:00"); // the week of Oct 12, the first one with prizes
    await buy(retro, "r2", 100, "2026-10-15 10:00:00");
    await retro.shar.getSummary("r1", new Date("2026-10-21T12:00:00Z"));
    const after = (await retro.client.query("select user_id, shar, to_char(week_start,'YYYY-MM-DD') as wk from shar_weekly_awards order by place")).rows;
    check("prizes: a week before they began (Oct 5 to 11) is never paid after the fact, and the first paid week is Oct 12 to 18", R.WEEKLY_PRIZE_FROM_WEEK === "2026-10-12" && before === 0 && after.map((x) => x.user_id + ":" + x.shar + ":" + x.wk).join() === "r1:50:2026-10-12,r2:30:2026-10-12");
    const offDb = await freshDb();
    offDb.load("src/lib/shar-spark-rules.ts").WEEKLY_PRIZE_SHAR.splice(0); // this test's own copy: prizes turned off
    await buy(offDb, "q1", 200, lastWeek);
    await offDb.shar.getSummary("q1", NOW);
    check("prizes: with the list emptied (prizes off) nothing is ever paid", (await offDb.client.query("select count(*)::int as n from shar_weekly_awards")).rows[0].n === 0 && (await offDb.shar.getLeaderboard("q1", NOW)).prizes.length === 0);
    const noTable = await freshDb();
    await noTable.client.exec("drop table shar_weekly_awards");
    const nt = await noTable.shar.getSummary("q1", NOW);
    check("prizes: before the migration is applied the summary still loads and claims stay on", nt.ready === true);
  }

  // ── before the migration has been applied
  const old = await freshDb({ sparksTable: false });
  const oldSum = await old.shar.getSummary("x", NOW);
  check("no table yet: the summary still works, claims stay enabled (ready true) and the spark reads as not set up", oldSum.ready === true && oldSum.spark.ready === false && oldSum.spark.streak === 0);
  const oldCollect = await old.shar.collectSpark("x", NOW);
  check("no table yet: collecting says 'being set up' (503) instead of crashing", !oldCollect.ok && oldCollect.status === 503);
  const oldBoard = await old.shar.getLeaderboard("x", NOW);
  check("no table yet: the weekly board still loads", Array.isArray(oldBoard.top));

  // ── the migration and the schema agree
  const sql = fs.readFileSync(path.join(__dirname, "../../drizzle/0016_shar_sparks.sql"), "utf8");
  check("migration: safe to run twice, keyed on (user, day), and applied after the Shar tables", sql.includes("IF NOT EXISTS \"shar_sparks\"") && sql.includes("PRIMARY KEY (\"user_id\", \"day\")") && migrations.FILES.indexOf("0016_shar_sparks.sql") > migrations.FILES.indexOf("0007_shar_rewards.sql"));
  await client.exec(sql.split("--> statement-breakpoint").map((s) => s.trim()).join("\n"));
  check("migration: running it a second time changes nothing", (await client.query("select count(*)::int as n from shar_sparks")).rows[0].n > 0);

  // ── the server-side Seeker check
  const seekerMod = (rpc, wallets, url = "https://rpc.example") =>
    makeLoader({
      "@/lib/auth": { getUserWalletAddresses: async () => ({ evm: [], solana: wallets }) },
      "@/lib/server-env": { getServerEnv: () => url },
      "@/lib/solana-rpc-proxy": { TOKEN_2022_PROGRAM: "Token2022", forwardRpc: async (_u, r) => ({ status: 200, body: JSON.stringify(rpc(r)) }) },
    })("src/lib/seeker-sgt.ts");
  const GROUP = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
  const sgtExt = [{ extension: "tokenGroupMember", state: { group: GROUP } }, { extension: "metadataPointer", state: { metadataAddress: GROUP } }];
  const acct = (mint, amount = 1) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { uiAmount: amount, decimals: 0 } } } } } });
  const answer = (mintsHeld, ext) => (r) =>
    r.method === "getTokenAccountsByOwner" ? { result: { value: mintsHeld } } : { result: { value: { data: { parsed: { info: { extensions: ext } } } } } };
  const sm1 = seekerMod(answer([acct("M1")], sgtExt), ["W1"]);
  check("sgt check: the SGT's group and pointer make a mint a Seeker Genesis Token; anything else does not", sm1.isSgtMint(sgtExt) && !sm1.isSgtMint([{ extension: "tokenGroupMember", state: { group: "other" } }, sgtExt[1]]) && !sm1.isSgtMint(undefined) && !sm1.isSgtMint([sgtExt[0]]));
  check("sgt check: a linked wallet holding one makes the account a holder", (await sm1.isSeekerHolder("u1")) === true);
  const sm2 = seekerMod(answer([acct("M1", 0)], sgtExt), ["W1"]);
  check("sgt check: an emptied token account (the SGT moved away) does not count", (await sm2.isSeekerHolder("u1")) === false);
  const sm3 = seekerMod(answer([acct("M1")], [{ extension: "metadataPointer", state: { metadataAddress: "x" } }]), ["W1"]);
  check("sgt check: some other Token-2022 NFT does not count", (await sm3.isSeekerHolder("u1")) === false);
  const sm4 = seekerMod(() => ({ error: { message: "rate limited" } }), ["W1"]);
  check("sgt check: an RPC error means not a holder this time, and the failure is not remembered", (await sm4.isSeekerHolder("u1")) === false);
  const sm5 = seekerMod(answer([acct("M1")], sgtExt), ["W1"], "");
  check("sgt check: with no RPC configured nobody is treated as a holder", (await sm5.isSeekerHolder("u1")) === false);
  const sm6 = seekerMod(answer([acct("M1")], sgtExt), []);
  check("sgt check: an account with no linked Solana wallet is not a holder", (await sm6.isSeekerHolder("u1")) === false);
  let calls = 0;
  const sm7 = seekerMod((r) => { calls++; return answer([acct("M1")], sgtExt)(r); }, ["W1"]);
  await sm7.isSeekerHolder("u9", 1000);
  const afterFirst = calls;
  await sm7.isSeekerHolder("u9", 2000);
  check("sgt check: a definite answer is remembered, so a second collect does not call the RPC again", calls === afterFirst);

  // ── the route is wired
  const route = fs.readFileSync(path.join(__dirname, "../../src/app/api/shar/spark/route.ts"), "utf8");
  check("route: POST /api/shar/spark needs sign-in, is rate limited, records the phone, and returns the server's amounts", route.includes("verifyAuth") && route.includes("checkApiLimit") && route.includes("noteDevice") && route.includes("collectSpark") && route.includes("export async function POST"));

  finish();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
