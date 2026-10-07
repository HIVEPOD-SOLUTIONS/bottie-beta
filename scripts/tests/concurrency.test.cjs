/**
 * Concurrency test for every money path, on a REAL Postgres.
 *
 * Neon's HTTP driver has no multi-statement transactions, so Bluvfi keeps each money movement to ONE SQL statement and relies on
 * Postgres to make that atomic however many requests race. PGlite (what the other suites use) has a single connection, so it
 * can't prove that. This script fires real parallel requests, each on its own connection, through the app's own driver
 * (@neondatabase/serverless + drizzle neon-http), and checks that no money is created, lost or spent twice.
 *
 *     RACE_DATABASE_URL="postgresql://user:pass@host/db?sslmode=require" node scripts/tests/concurrency.test.cjs
 *
 *   • Use a throwaway database (a fresh Neon branch is ideal). It builds its own tables, runs, and drops them again.
 *   • NEVER the production database. It refuses to run if it finds tables it doesn't own, unless RACE_WIPE=1 (which then also
 *     drops its own tables if they already exist). It never touches tables it doesn't create.
 *   • RACE_DATABASE_URL=pglite runs the same checks on the in-memory database. That only smoke-tests this script (PGlite
 *     serialises everything); it is not a race test.
 */
const { makeLoader, freshDb, reporter, req, migrations } = require("./_harness.cjs");
const { fakeChain } = require("./_fakechain.cjs");
const crypto = require("crypto");
const { check, finish } = reporter();

const bs58 = ((m) => m.default ?? m)(req("bs58"));
const sig = () => bs58.encode(crypto.randomBytes(64));
const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const FEE = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const PAY_TO = "BLuvF1DepositAddress11111111111111111111111";
const PAYER = "AgentWa11et1111111111111111111111111111111";
const URL_ = process.env.RACE_DATABASE_URL;

// Statements can start with a comment block, so search each one rather than anchoring to its first line.
const OUR_TABLES = ["payments", ...new Set(migrations.statements.flatMap((s) => [...s.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/gi)].map((m) => m[1])))];
const PAYMENTS_TABLE = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;

async function connect() {
  const schema = makeLoader({})("src/lib/db/schema.ts");
  if (URL_ === "pglite") {
    const { client, db } = await freshDb();
    return { db, q: async (t, p = []) => (await client.query(t, p)).rows, teardown: async () => {}, label: "PGlite (smoke test only, no real concurrency)" };
  }
  const { neon } = req("@neondatabase/serverless");
  const { drizzle } = req("drizzle-orm/neon-http");
  const client = neon(URL_);
  const q = async (t, p = []) => client.query(t, p);
  const have = (await q(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).map((r) => r.table_name);
  const foreign = have.filter((t) => !OUR_TABLES.includes(t));
  const ours = have.filter((t) => OUR_TABLES.includes(t));
  if ((foreign.length || ours.length) && process.env.RACE_WIPE !== "1") {
    console.error(`REFUSING TO RUN: this database already has tables (${[...foreign, ...ours].slice(0, 8).join(", ")}${have.length > 8 ? ", …" : ""}).`);
    console.error("Use a fresh, empty database. If it really is a throwaway, rerun with RACE_WIPE=1 (it drops only the tables this test owns).");
    process.exit(3);
  }
  const drop = async () => { for (const t of OUR_TABLES) await q(`drop table if exists "${t}" cascade`); };
  await drop();
  await q(PAYMENTS_TABLE);
  for (const stmt of migrations.statements) await q(stmt);
  const host = (() => { try { return new URL(URL_).hostname; } catch { return "?"; } })();
  return { db: drizzle({ client, schema }), q, teardown: drop, label: `real Postgres via ${host} (neon-http, the production driver)` };
}

(async () => {
  const { db, q, teardown, label } = await connect();
  console.log(`database: ${label}\n`);
  const started = Date.now();
  const stubs = {
    "@/lib/db": { db },
    "@/lib/auth": { getUserWalletAddresses: async () => ({ evm: [], solana: [] }) },
    "@/lib/server-env": { getServerEnv: () => undefined },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
  };
  const load = makeLoader(stubs);
  const net = load("src/lib/provider-network.ts");
  const credits = load("src/lib/credits.ts");
  const earnings = load("src/lib/earnings.ts");
  const shar = load("src/lib/shar.ts");
  const rules = load("src/lib/x402-rules.ts");
  const edge = load("src/lib/x402-edge.ts");
  const payout = load("src/lib/skr-payout.ts");
  const one = async (text, params = []) => (await q(text, params))[0];
  const num = (v) => Number(v ?? 0);

  const mk = async (owner, name, price) => {
    const r = await net.createListing(owner, { name, summary: "Does something useful for testing.", category: "data", endpointUrl: "https://api.example.com/v1", priceUsdc: price, payoutWallet: WALLET });
    if (!r.ok) throw new Error(r.error);
    await net.reviewListing(r.listing.id, "verify", null);
    return net.getListing(r.listing.id);
  };
  const N = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const okCall = async () => ({ ok: true, status: 200, body: { answer: 42 } });
  const balance = async (u) => num((await one(`select balance_micro from credit_balances where user_id = $1`, [u]))?.balance_micro);

  // ── 1. Overspending: 50 calls race for a balance that pays for 20
  {
    const l = await mk("RACE_OWNER_1", "Debit Wisp", "0.05");
    await credits.creditTopup("R1", "sig-r1", 1_000_000);
    const res = await Promise.all(N(50, () => credits.debitForCall("R1", l.id, 50_000)));
    const won = res.filter((r) => r.ok).length;
    check("50 simultaneous debits against $1.00 at $0.05: exactly 20 succeed", won === 20, `won=${won}`);
    check("the balance ends at exactly 0, never below", (await balance("R1")) === 0);
    const led = await one(`select count(*)::int n, coalesce(sum(amount_micro),0)::bigint s from credit_ledger where user_id = 'R1' and kind = 'call'`);
    check("the ledger holds 20 debits totalling exactly -1,000,000", num(led.n) === 20 && num(led.s) === -1_000_000, JSON.stringify(led));
  }

  // ── 2. Top-up replays
  {
    const res = await Promise.all(N(30, () => credits.creditTopup("R2", "sig-r2-same", 1_000_000)));
    check("the SAME deposit credited 30 times at once: credited exactly once", res.filter((r) => r.credited).length === 1 && (await balance("R2")) === 1_000_000);
    const users = N(20, (i) => `R2U${i}`);
    const res2 = await Promise.all(users.map((u) => credits.creditTopup(u, "sig-r2-shared", 1_000_000)));
    const total = num((await one(`select coalesce(sum(balance_micro),0)::bigint s from credit_balances where user_id like 'R2U%'`)).s);
    check("one deposit claimed by 20 DIFFERENT users at once: exactly one gets it", res2.filter((r) => r.credited).length === 1 && total === 1_000_000, `total=${total}`);
  }

  // ── 3. Refund race
  {
    const l = await mk("RACE_OWNER_3", "Refund Wisp", "0.05");
    await credits.creditTopup("R3", "sig-r3", 1_000_000);
    const d = await credits.debitForCall("R3", l.id, 50_000);
    const res = await Promise.all(N(20, () => credits.refundCall("R3", d.ledgerId, 50_000)));
    check("one failed call refunded 20 times at once: given back exactly once", res.filter((r) => r.refunded).length === 1 && (await balance("R3")) === 1_000_000);
  }

  // ── 4. Paid calls: nobody overspends, and the owner's commission adds up exactly
  {
    const l = await mk("RACE_OWNER_4", "Busy Wisp", "0.05");
    const callers = N(40, (i) => `R4C${i}`);
    await Promise.all(callers.map((c, i) => credits.creditTopup(c, `sig-r4-${i}`, 1_000_000)));
    await credits.creditTopup("R4BURST", "sig-r4-burst", 1_000_000);
    let calls = 0;
    const counted = async () => { calls++; return { ok: true, status: 200, body: { answer: 42 } }; };
    const spread = await Promise.all(callers.map((c) => net.runProviderCall(l, c, {}, counted)));
    const burst = await Promise.all(N(30, () => net.runProviderCall(l, "R4BURST", {}, counted)));
    const burstOk = burst.filter((r) => r.ok).length;
    check("40 different callers at once: every call succeeds and is charged exactly $0.05", spread.every((r) => r.ok && r.chargedMicro === 50_000));
    check("one caller firing 30 calls at once with money for 20: exactly 20 succeed, 10 get 402", burstOk === 20 && burst.filter((r) => !r.ok && r.status === 402).length === 10, `ok=${burstOk}`);
    check("the burst caller's balance is exactly 0, the others' exactly $0.95", (await balance("R4BURST")) === 0 && (await Promise.all(callers.map(balance))).every((b) => b === 950_000));
    check("the provider ran only for calls that were charged (60)", calls === 60, `calls=${calls}`);
    const e = await one(`select available_micro, lifetime_micro from earnings_balances where user_id = 'RACE_OWNER_4'`);
    check("the owner earned exactly 60 x 40,000 = 2,400,000 with no lost updates", num(e.available_micro) === 2_400_000 && num(e.lifetime_micro) === 2_400_000, JSON.stringify(e));
    const u = await one(`select count(*)::int n, sum(paid_micro)::bigint p, sum(owner_micro)::bigint o, sum(platform_micro)::bigint f from provider_usage where listing_id = $1`, [l.id]);
    check("60 usage rows; owner + platform = paid", num(u.n) === 60 && num(u.p) === 3_000_000 && num(u.o) + num(u.f) === num(u.p), JSON.stringify(u));
  }

  // ── 5. Withdrawing while commission is arriving: not a micro-USDC created or lost
  {
    const l = await mk("RACE_OWNER_5", "Earning Wisp", "0.05");
    await q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ('RACE_OWNER_5', 8200000, 8200000)`);
    const callers = N(10, (i) => `R5C${i}`);
    await Promise.all(callers.map((c, i) => credits.creditTopup(c, `sig-r5-${i}`, 1_000_000)));
    const [w, c] = await Promise.all([
      Promise.all(N(10, () => earnings.requestWithdrawal("RACE_OWNER_5", WALLET))),
      Promise.all(callers.map((cu) => net.runProviderCall(l, cu, {}, okCall))),
    ]);
    const made = w.filter((r) => r.ok).length;
    const paidOut = num((await one(`select coalesce(sum(usd_micro),0)::bigint s from commission_payouts where user_id = 'RACE_OWNER_5'`)).s);
    const left = num((await one(`select available_micro from earnings_balances where user_id = 'RACE_OWNER_5'`)).available_micro);
    const earned = c.filter((r) => r.ok).length * 40_000;
    check("10 withdrawals at once: exactly one is created (what arrives meanwhile is under the $5 minimum)", made === 1, `made=${made}`);
    check("CONSERVATION: withdrawn + still available = $8.20 + everything earned meanwhile, to the micro-USDC", paidOut + left === 8_200_000 + earned, `paidOut=${paidOut} left=${left} earned=${earned}`);
    check("the balance is never negative", left >= 0);
  }

  // ── 6. Two quick taps on "claim"
  {
    await q(`insert into payments (user_id, type, status, amount_usdc, description) values ('R6', 'bill', 'completed', '3000', 'Gift card')`);
    const res = await Promise.all(N(10, () => shar.createClaim("R6", { shar: 1000, wallet: WALLET })));
    const open = num((await one(`select count(*)::int n from shar_claims where user_id = 'R6' and status in ('requested','processing','sent')`)).n);
    check("10 claim requests at once: exactly one claim is created", res.filter((r) => r.ok).length === 1 && open === 1, `ok=${res.filter((r) => r.ok).length} open=${open}`);
  }

  // ── 7. Several admins click Pay on the same payout (acknowledged: this script reuses one wallet for many fake users, which the abuse check rightly flags)
  {
    await q(`insert into payments (user_id, type, status, amount_usdc, description) values ('R7', 'bill', 'completed', '2000', 'Gift card')`);
    const claim = await shar.createClaim("R7", { shar: 1000, wallet: WALLET });
    const chain = fakeChain();
    const res = await Promise.all(N(10, () => payout.payPayout({ kind: "shar_claim", id: claim.claim.id, acknowledgeRisk: true }, chain)));
    check("10 simultaneous Pay clicks: exactly ONE transaction is broadcast", chain.state.sent.length === 1, `sent=${chain.state.sent.length}`);
    check("exactly one click succeeds, the rest are told it is taken", res.filter((r) => r.ok).length === 1 && res.filter((r) => !r.ok && r.status === 409).length === 9);
    const row = await one(`select status from shar_claims where id = $1`, [claim.claim.id]);
    check("the claim ends paid (or sent, awaiting confirmation), never twice", row.status === "paid" || row.status === "sent", row.status);
  }

  // ── 8 + 9. x402: the same payment twice at once, and a payment racing a top-up for the same signature
  {
    const l = await mk("RACE_OWNER_8", "Agent Wisp", "0.05");
    const cfg = rules.loadX402Config((n) => ({ X402_FACILITATOR_URL: "https://facilitator.example.com", CREDITS_DEPOSIT_ADDRESS: PAY_TO })[n]);
    const reqs = rules.buildRequirements(cfg, 50_000, FEE);
    const header = (tx) => rules.encodeHeader({ x402Version: 2, accepted: reqs, payload: { transaction: tx } });
    const log = [];
    let settleSig = () => sig();
    const facilitator = {
      feePayer: async () => FEE,
      verify: async () => ({ kind: "valid", payer: PAYER }),
      settle: async (p) => { log.push("settle"); return { kind: "ok", transaction: typeof settleSig === "function" ? settleSig(p) : settleSig, payer: PAYER }; },
    };
    let provider = 0;
    const deps = { config: cfg, facilitator, callProvider: async () => { provider++; return { ok: true, status: 200, body: { answer: 42 } }; } };
    const call = (tx) => edge.handleX402Call({ listing: l, url: "https://www.bluvfi.xyz/api/network/providers/x/x402", paymentHeader: header(tx), payload: {} }, deps);
    const usageOf = async () => num((await one(`select count(*)::int n from provider_usage where listing_id = $1 and paid_micro > 0`, [l.id])).n);

    const res = await Promise.all(N(15, () => call("tx-same")));
    const codes = res.map((r) => r.status);
    check("the same signed payment presented 15 times at once: exactly one 200", codes.filter((c) => c === 200).length === 1 && codes.every((c) => c === 200 || c === 409), codes.join());
    check("…the provider ran once, settle ran once, one usage row, owner earned 40,000", provider === 1 && log.length === 1 && (await usageOf()) === 1
      && num((await one(`select available_micro from earnings_balances where user_id = 'RACE_OWNER_8'`)).available_micro) === 40_000);

    // a payment racing a credits top-up for the same on-chain signature
    const origError = console.error;
    console.error = () => {};
    const rounds = 12;
    const winners = { x402: 0, topup: 0 };
    for (let i = 0; i < rounds; i++) {
      const s = sig();
      settleSig = () => s;
      // The top-up is one statement and the x402 flow is several, so fired together the top-up always wins. Starting it at a spread of
      // moments (0 to ~1.2s in) makes it land before, during and after the x402 settlement, so both orders are exercised.
      const delay = Math.floor((i / (rounds - 1)) * 1200);
      const [r, t] = await Promise.all([call(`tx-race-${i}`), new Promise((ok) => setTimeout(ok, delay)).then(() => credits.creditTopup(`R9U${i}`, s, 1_000_000))]);
      const claims = await q(`select kind from signature_claims where signature = $1`, [s]);
      const usage = num((await one(`select count(*)::int n from provider_usage where settlement_ref = $1`, [s])).n);
      const topups = num((await one(`select count(*)::int n from credit_ledger where kind = 'topup' and ref = $1`, [s])).n);
      const ok = claims.length === 1 && usage + topups === 1 && (claims[0].kind === "x402" ? usage === 1 && !t.credited : topups === 1 && usage === 0 && r.status === 200);
      if (!ok) check(`round ${i}: a signature belongs to exactly one of {x402 payment, top-up}`, false, JSON.stringify({ claims, usage, topups, status: r.status, credited: t.credited }));
      winners[claims[0]?.kind === "x402" ? "x402" : "topup"]++;
    }
    console.error = origError;
    check(`12 rounds of x402 payment vs top-up on the same signature: never both, never neither (x402 won ${winners.x402}, top-up won ${winners.topup})`, (await q(`select 1 from signature_claims`)).length >= rounds);
    const doubleCounted = num((await one(`select count(*)::int n from provider_usage u join credit_ledger l on l.kind = 'topup' and l.ref = u.settlement_ref`)).n);
    check("no signature is counted as both a provider payment and credits", doubleCounted === 0);
  }

  await teardown();
  console.log(`\nfinished in ${((Date.now() - started) / 1000).toFixed(1)}s; the test's tables were dropped.`);
  finish();
})().catch(async (e) => {
  process.stderr.write(`CONCURRENCY TEST CRASHED ${(e && e.stack) || e}\n`);
  process.exit(2);
});
