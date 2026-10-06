/**
 * Claiming Shar as SKR, at the REAL rate and minimum from src/lib/shar-rules.ts (nothing is patched for the test).
 * Runs the real src/lib/shar.ts and drizzle/0007_shar_rewards.sql on an in-memory Postgres (PGlite), never Neon.
 *
 *     npm i --no-save @electric-sql/pglite
 *     node scripts/tests/shar-claim.test.cjs
 *
 * (Set PGLITE_PATH to the folder holding node_modules/@electric-sql/pglite to keep it elsewhere.)
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
const { SHAR } = rules;
const MIGRATION = fs.readFileSync(path.join(ROOT, "drizzle/0007_shar_rewards.sql"), "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const PAYMENTS = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;
const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";

async function freshDb() {
  const client = new PGlite();
  await client.exec(PAYMENTS);
  for (const stmt of MIGRATION) await client.exec(stmt);
  const shar = load("src/lib/shar.ts", { "@/lib/db": { db: drizzle(client, { schema }) }, "@/lib/db/schema": schema, "@/lib/shar-rules": rules });
  return { client, shar };
}
const spend = (client, user, usd) =>
  client.query(`insert into payments (user_id, type, status, amount_usdc, description) values ($1, 'bill', 'completed', $2, 'Gift card')`, [user, String(usd)]);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  -> ${detail}` : ""}`);
};

(async () => {
  const MIN = SHAR.minClaimShar;
  check("the real constants are in force: minimum 1,000 Shar, 1 Shar = 0.9 SKR", MIN === 1000 && SHAR.skrPerShar === 0.9);

  const { client, shar } = await freshDb();
  await spend(client, "U1", 2500); // 2,500 Shar
  const s0 = await shar.getSummary("U1");
  check("2,500 Shar available, worth 2,250 SKR", s0.available === 2500 && s0.skr.availableSkr === "2250", `${s0.available} / ${s0.skr.availableSkr}`);
  check("the summary tells the app the minimum and the rate", s0.claim.minShar === 1000 && s0.rules.skrPerShar === 0.9 && s0.rules.minClaimShar === 1000);

  const below = await shar.createClaim("U1", { shar: MIN - 1, wallet: WALLET });
  check("999 Shar is refused (400), and the message names the minimum", below.ok === false && below.status === 400 && /1,000/.test(below.error), below.error);
  check("the old minimum (50) no longer works", (await shar.createClaim("U1", { shar: 50, wallet: WALLET })).status === 400);
  check("more than available is refused", (await shar.createClaim("U1", { shar: 2501, wallet: WALLET })).status === 400);
  check("a bad wallet is refused", (await shar.createClaim("U1", { shar: MIN, wallet: "nope" })).status === 400);

  const ok = await shar.createClaim("U1", { shar: MIN, wallet: WALLET });
  check("exactly 1,000 Shar is accepted and fixed at 900 SKR", ok.ok === true && ok.claim.shar === 1000 && ok.claim.skr === "900", ok.ok ? ok.claim.skr : ok.error);
  const stored = (await client.query(`select shar, skr_amount, status from shar_claims`)).rows[0];
  check("the stored claim keeps the SKR amount it was made with", stored.skr_amount === "900" && stored.shar === 1000 && stored.status === "requested");

  const s1 = await shar.getSummary("U1");
  check("available drops by the claim (2,500 - 1,000 = 1,500 = 1,350 SKR); lifetime unchanged", s1.available === 1500 && s1.skr.availableSkr === "1350" && s1.lifetime === 2500, `${s1.available}/${s1.skr.availableSkr}/${s1.lifetime}`);
  check("the open claim is reported with its SKR", s1.claim.open && s1.claim.open.shar === 1000 && s1.claim.open.skr === "900");
  check("a second claim while one is open is refused (409)", (await shar.createClaim("U1", { shar: MIN, wallet: WALLET })).status === 409);

  await client.query(`update shar_claims set status = 'rejected'`);
  check("a rejected claim returns the Shar", (await shar.getSummary("U1")).available === 2500);

  const [a, b] = await Promise.all([shar.createClaim("U1", { shar: 1000, wallet: WALLET }), shar.createClaim("U1", { shar: 1000, wallet: WALLET })]);
  const open = (await client.query(`select count(*)::int as n from shar_claims where status = 'requested'`)).rows[0].n;
  check("two simultaneous taps create exactly one claim", [a, b].filter((x) => x.ok).length === 1 && open === 1, `open=${open}`);

  await client.query(`update shar_claims set status = 'paid' where status = 'requested'`);
  const s2 = await shar.getSummary("U1");
  check("a paid claim keeps the Shar spent (1,500 left)", s2.available === 1500 && s2.claim.open === null, String(s2.available));
  const afterPaid = await shar.createClaim("U1", { shar: 1000, wallet: WALLET });
  check("after a paid claim, another can be made from what is left (900 SKR)", afterPaid.ok === true && afterPaid.claim.skr === "900");

  // A user who is just below the minimum cannot claim, however the balance is made up.
  const low = await freshDb();
  await spend(low.client, "U2", 999);
  check("999 Shar available: a claim of all of it is refused", (await low.shar.createClaim("U2", { shar: 999, wallet: WALLET })).status === 400);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST HARNESS ERROR", e);
  process.exit(1);
});
