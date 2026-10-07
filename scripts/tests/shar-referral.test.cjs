/**
 * Referral rules for Shar: a referrer earns a bonus only on spending their friend did AFTER entering the code.
 *
 * Runs the real src/lib/shar.ts and the real drizzle/0007_shar_rewards.sql against an in-memory Postgres (PGlite), so it never
 * touches Neon. PGlite isn't a dependency of the app; install it once without saving it:
 *
 *     npm i --no-save @electric-sql/pglite
 *     node scripts/tests/shar-referral.test.cjs
 *
 * (To keep it elsewhere, set PGLITE_PATH to the folder that contains node_modules/@electric-sql/pglite.)
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
const req = (name) => require(path.join(ROOT, "node_modules", name));
function loadPglite() {
  const tries = [() => require("@electric-sql/pglite"), () => req("@electric-sql/pglite")];
  if (process.env.PGLITE_PATH) tries.push(() => require(path.join(process.env.PGLITE_PATH, "node_modules/@electric-sql/pglite")));
  for (const t of tries) {
    try {
      return t();
    } catch {
      /* try the next place */
    }
  }
  console.error("Missing @electric-sql/pglite. Run: npm i --no-save @electric-sql/pglite");
  process.exit(2);
}
const { PGlite } = loadPglite();
const ts = req("typescript");
const { drizzle: drizzleProxy } = req("drizzle-orm/pg-proxy");

// drizzle's pg-proxy driver lets PGlite live anywhere on disk.
const drizzle = (client, opts) =>
  drizzleProxy(async (query, params, method) => ({ rows: (await client.query(query, params, method === "all" ? { rowMode: "array" } : undefined)).rows }), opts);

const compile = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(ROOT, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const load = (file, extra = {}) => {
  const m = { exports: {} };
  new Function("module", "exports", "require", compile(file))(m, m.exports, (name) => {
    if (name in extra) return extra[name];
    if (name === "drizzle-orm" || name === "drizzle-orm/pg-core") return req(name);
    throw new Error(`unexpected import "${name}" in ${file}`);
  });
  return m.exports;
};

const schema = load("src/lib/db/schema.ts");
const rules = load("src/lib/shar-rules.ts");
const MIGRATION = require("./_migrations.cjs").statements; // every migration the Shar code needs, in order
const PAYMENTS = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;

async function freshDb() {
  const client = new PGlite();
  await client.exec(PAYMENTS);
  for (const stmt of MIGRATION) await client.exec(stmt);
  const db = drizzle(client, { schema });
  const abuse = load("src/lib/abuse.ts", { "@/lib/db": { db: db }, "@/lib/abuse-rules": load("src/lib/abuse-rules.ts", { "node:crypto": require("node:crypto") }) });
  const shar = load("src/lib/shar.ts", { "@/lib/db": { db: db }, "@/lib/db/schema": schema, "@/lib/shar-rules": rules, "@/lib/abuse": abuse });
  return { client, shar };
}

// A purchase `when` (a SQL timestamp expression, on the database's own clock) relative to the moment the code is entered.
const pay = (client, user, amount, when, status = "completed") =>
  client.query(`insert into payments (user_id, type, status, amount_usdc, description, created_at) values ($1, 'bill', $2, $3, 'Gift card', ${when})`, [user, status, amount]);
const before = "now() - interval '30 days'";
const after = "now() + interval '1 minute'";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  -> ${detail}` : ""}`);
};

(async () => {
  // 1. The bug: spending that happened before the code was entered must not pay the referrer.
  {
    const { client, shar } = await freshDb();
    await pay(client, "FRIEND", "1000", before);
    const code = (await shar.getSummary("REFERRER")).referral.code;
    check("before the code: referrer bonus is 0", (await shar.getSummary("REFERRER")).referral.bonus === 0);
    check("entering the code works", (await shar.attachReferral("FRIEND", code)).ok === true);
    const s = await shar.getSummary("REFERRER");
    check("a $1,000 purchase made a month earlier earns the referrer nothing", s.referral.bonus === 0 && s.available === 0, `bonus=${s.referral.bonus} available=${s.available}`);
    check("the friend still counts as referred", s.referral.referred === 1);
    const f = await shar.getSummary("FRIEND");
    check("the friend keeps all of their own Shar (1000)", f.available === 1000, String(f.available));
  }

  // 2. Spending before and after: only the "after" part pays.
  {
    const { client, shar } = await freshDb();
    await pay(client, "FRIEND", "100", before);
    const code = (await shar.getSummary("REFERRER")).referral.code;
    await shar.attachReferral("FRIEND", code);
    await pay(client, "FRIEND", "50", after);
    const s = await shar.getSummary("REFERRER");
    check("$100 before + $50 after: bonus is 10% of the $50 only (5)", s.referral.bonus === 5 && s.available === 5, `bonus=${s.referral.bonus}`);
  }

  // 3. A pending purchase after the code earns the referrer nothing until it completes.
  {
    const { client, shar } = await freshDb();
    const code = (await shar.getSummary("REFERRER")).referral.code;
    await shar.attachReferral("FRIEND", code);
    await pay(client, "FRIEND", "200", after, "pending");
    check("pending purchase after the code: no bonus yet", (await shar.getSummary("REFERRER")).referral.bonus === 0);
    await client.query(`update payments set status = 'completed' where user_id = 'FRIEND'`);
    check("completed: bonus is 10% of $200 (20)", (await shar.getSummary("REFERRER")).referral.bonus === 20);
  }

  // 4. A purchase created at the exact moment the code was entered counts (the boundary is inclusive).
  {
    const { client, shar } = await freshDb();
    const code = (await shar.getSummary("REFERRER")).referral.code;
    await shar.attachReferral("FRIEND", code);
    await client.query(`insert into payments (user_id, type, status, amount_usdc, description, created_at) select 'FRIEND', 'bill', 'completed', '300', 'Gift card', referred_at from shar_profiles where user_id = 'FRIEND'`);
    check("a purchase stamped exactly at the moment of entry counts (30)", (await shar.getSummary("REFERRER")).referral.bonus === 30);
  }

  // 5. Trying a second code can't move the date and re-count old spending.
  {
    const { client, shar } = await freshDb();
    const code1 = (await shar.getSummary("R1")).referral.code;
    const code2 = (await shar.getSummary("R2")).referral.code;
    await shar.attachReferral("FRIEND", code1);
    const t1 = (await client.query(`select referred_at from shar_profiles where user_id = 'FRIEND'`)).rows[0].referred_at;
    await pay(client, "FRIEND", "100", "now() - interval '1 second'");
    const again = await shar.attachReferral("FRIEND", code2);
    const t2 = (await client.query(`select referred_at, referred_by from shar_profiles where user_id = 'FRIEND'`)).rows[0];
    check("second code is refused (409)", again.ok === false && again.status === 409);
    check("the first referrer and the original date are unchanged", t2.referred_by === "R1" && String(t2.referred_at) === String(t1));
    check("the second referrer earns nothing", (await shar.getSummary("R2")).referral.bonus === 0);
  }

  // 6. A link made before this rule existed (no date recorded) earns nothing, rather than paying for unknown spending.
  {
    const { client, shar } = await freshDb();
    await shar.getSummary("REFERRER");
    await shar.getSummary("FRIEND");
    await client.query(`update shar_profiles set referred_by = 'REFERRER', referred_at = null where user_id = 'FRIEND'`);
    await pay(client, "FRIEND", "500", after);
    const s = await shar.getSummary("REFERRER");
    check("legacy link with no date: no bonus, but still counted as referred", s.referral.bonus === 0 && s.referral.referred === 1, `bonus=${s.referral.bonus}`);
  }

  // 7. Upgrading a database that already has the OLD shar_profiles table (no referred_at): the migration adds the column and keeps rows.
  {
    const client = new PGlite();
    await client.exec(PAYMENTS);
    await client.exec(`create table shar_profiles (user_id text primary key not null, referral_code text not null, referred_by text, created_at timestamp default now() not null, constraint shar_profiles_referral_code_unique unique(referral_code))`);
    await client.exec(`insert into shar_profiles (user_id, referral_code, referred_by) values ('OLD', 'AAAAAAAA', 'SOMEONE')`);
    for (const stmt of MIGRATION) await client.exec(stmt);
    const cols = (await client.query(`select column_name from information_schema.columns where table_name = 'shar_profiles'`)).rows.map((r) => r.column_name);
    check("old database: referred_at is added", cols.includes("referred_at"), cols.join(","));
    const old = (await client.query(`select user_id, referred_by, referred_at from shar_profiles`)).rows[0];
    check("old database: the existing row is kept, with no date", old.user_id === "OLD" && old.referred_by === "SOMEONE" && old.referred_at === null);
    let again = null;
    try {
      for (const stmt of MIGRATION) await client.exec(stmt);
    } catch (e) {
      again = e;
    }
    check("running the migration a second time is harmless", again === null, again ? again.message : "");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST HARNESS ERROR", e);
  process.exit(1);
});
