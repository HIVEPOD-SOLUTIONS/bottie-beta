/**
 * Shar end to end: the pure rules (spending, tiers, weeks, SKR maths, referral bonus, handles), then the whole flow against a
 * real Postgres engine (PGlite) built from the real migrations: summary, referrals, provider earnings, claims (including two
 * taps at once), the weekly leaderboard, and what happens before the migration has been applied.
 *
 * The real minimum claim is 1,000 Shar. These fixtures are small, so the test lowers it to 50 at runtime (on its own copy of the
 * rules module; nothing in src/ is touched).
 *
 *     node scripts/tests/shar.test.cjs
 */
const { PGlite, makeLoader, reporter, req, migrations } = require("./_harness.cjs");
const { check, finish } = reporter();
const { drizzle: drizzleProxy } = req("drizzle-orm/pg-proxy");

const drizzle = (client, opts) =>
  drizzleProxy(async (query, params, method) => ({ rows: (await client.query(query, params, method === "all" ? { rowMode: "array" } : undefined)).rows }), opts);

const stubs = { "@/lib/server-env": { getServerEnv: () => undefined } };
const schema = makeLoader({})("src/lib/db/schema.ts");
const rules = makeLoader({})("src/lib/shar-rules.ts"); // untouched, for the pure checks
const PAYMENTS_SQL = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;

async function freshDb({ migrate = true } = {}) {
  const client = new PGlite();
  await client.exec(PAYMENTS_SQL);
  if (migrate) for (const stmt of migrations.statements) await client.exec(stmt);
  const db = drizzle(client, { schema });
  const load = makeLoader({ ...stubs, "@/lib/db": { db } });
  load("src/lib/shar-rules.ts").SHAR.minClaimShar = 50; // this copy only: shar.ts below reads the same object
  const shar = load("src/lib/shar.ts");
  return { client, db, shar };
}

const NOW = new Date('2026-10-07T12:00:00Z'); // a Wednesday; the week began Mon 2026-10-05 00:00 UTC
const iso = (d) => d.toISOString().replace('T', ' ').replace('Z', '');
const WALLET = 'ArFpjVx3dMZ6hPzBq2Tq9t9hX1u1cYd8vN5KfZw4v5Qy'.slice(0, 44);
const addPay = (c, userId, type, status, amount, createdAt, description = 'Netflix gift card') =>
  c.query('insert into payments (user_id,type,status,amount_usdc,description,created_at) values ($1,$2,$3,$4,$5,$6)', [userId, type, status, amount, description, iso(createdAt)]);

(async () => {
  // ── pure rules
  const r = rules;
  check('rules: $25.50 completed bill = 25 Shar available', JSON.stringify(r.sharForPayment({ type: 'bill', status: 'completed', amountUsdc: '25.50' })) === '{"shar":25,"state":"available"}');
  check('rules: pending purchase is pending', r.sharForPayment({ type: 'bill', status: 'pending', amountUsdc: '40' }).state === 'pending');
  check('rules: under $10 earns nothing', r.sharForPayment({ type: 'bill', status: 'completed', amountUsdc: '9.99' }).shar === 0);
  check('rules: banking/onramp does not earn', r.sharForPayment({ type: 'onramp', status: 'completed', amountUsdc: '500' }).shar === 0);
  check('rules: failed does not earn', r.sharForPayment({ type: 'bill', status: 'failed', amountUsdc: '50' }).shar === 0);
  check('rules: junk amount does not earn (and does not throw)', r.sharForPayment({ type: 'bill', status: 'completed', amountUsdc: 'abc' }).shar === 0);
  check('tiers: 0->Spark, 100->Wisp, 499->Wisp, 500->Guide, 2000->Seeker', ['Spark', 'Wisp', 'Wisp', 'Guide', 'Seeker'].every((n, i) => r.tierFor([0, 100, 499, 500, 2000][i]).name === n));
  check('tiers: progress to next rung (250 of 100..500 = 0.375)', Math.abs(r.tierFor(250).progress - 0.375) < 1e-9);
  check('week: Wed 2026-10-07 -> Mon 2026-10-05 00:00Z', r.weekStartUtc(NOW).toISOString() === '2026-10-05T00:00:00.000Z');
  check('week: Sunday belongs to the week that began the Monday before', r.weekStartUtc(new Date('2026-10-11T23:59:59Z')).toISOString() === '2026-10-05T00:00:00.000Z');
  check('week: Monday 00:00 starts a new week', r.weekStartUtc(new Date('2026-10-12T00:00:00Z')).toISOString() === '2026-10-12T00:00:00.000Z');
  check('skr: 1 Shar = 0.9 SKR (50 Shar = 45, 7 Shar = 6.3 exactly)', r.skrForShar(50) === '45' && r.skrForShar(7) === '6.3' && r.skrForShar(1) === '0.9');
  check('referral: 10% of 205 = 20 (floored)', r.referralBonus(205) === 20);
  check('handle is stable and hides the id', (await r.handleFor('did:privy:abc')) === (await r.handleFor('did:privy:abc')) && /^Seeker [0-9A-F]{4}$/.test(await r.handleFor('did:privy:abc')));

  // ── full flow against Postgres
  const { client: c, shar: s } = await freshDb();
  const day = (d) => new Date(NOW.getTime() - d * 86400000);
  await addPay(c, 'U1', 'bill', 'completed', '25.50', day(1));       // 25 (this week)
  await addPay(c, 'U1', 'bill', 'pending', '40', day(0));            // 40 pending
  await addPay(c, 'U1', 'bill', 'completed', '9.99', day(1));        // 0
  await addPay(c, 'U1', 'investment', 'completed', '100', day(10));  // 100 (last week)
  await addPay(c, 'U1', 'onramp', 'completed', '500', day(1));       // excluded type
  await addPay(c, 'U1', 'bill', 'failed', '50', day(1));             // failed
  await addPay(c, 'U1', 'bill', 'completed', 'abc', day(1));         // junk amount must not break the query
  let sum = await s.getSummary('U1', NOW);
  check('summary: available = 25 + 100', sum.available === 125, sum.available);
  check('summary: pending = 40', sum.pending === 40, sum.pending);
  check('summary: this week counts only this week (25)', sum.week === 25, sum.week);
  check('summary: tables exist -> ready', sum.ready === true);
  check('summary: ladder (125 lifetime) = Wisp, next Guide at 500', sum.tier.name === 'Wisp' && sum.tier.next.at === 500);
  check('summary: has a referral code of the right shape', rules.isReferralCode(sum.referral.code), sum.referral.code);
  check('summary: activity lists qualifying purchases only', sum.activity.length === 3 && sum.activity.every((a) => a.kind === 'purchase'), sum.activity.length);

  // referrals
  const code1 = sum.referral.code;
  check('referral: bad format rejected', (await s.attachReferral('U2', 'nope')).status === 400);
  check('referral: unknown code rejected', (await s.attachReferral('U2', 'AAAAAAAA')).status === 404);
  check('referral: own code rejected', (await s.attachReferral('U1', code1)).status === 400);
  check('referral: valid code attaches', (await s.attachReferral('U2', code1.toLowerCase())).ok === true);
  check('referral: second code rejected (once only)', (await s.attachReferral('U2', code1)).status === 409);
  await addPay(c, 'U2', 'bill', 'completed', '205', new Date(Date.now() + 60000)); // after the code was entered: before-entry spending no longer pays the referrer
  sum = await s.getSummary('U1', NOW);
  check('referral: U1 earns 10% of U2 spending (20) -> 145', sum.available === 145 && sum.referral.bonus === 20 && sum.referral.referred === 1, `${sum.available} bonus=${sum.referral.bonus}`);
  const u2 = await s.getSummary('U2', NOW);
  check('referral: U2 keeps their own full 205', u2.available === 205, u2.available);

  // provider usage credits the owner
  await c.query(`insert into provider_listings (id, owner_user_id, name, slug, summary, category, endpoint_url, payout_wallet, status) values ('11111111-1111-1111-1111-111111111111','U1','Weather Wisp','weather-wisp','Forecasts for travellers','data','https://api.example.com/w','${WALLET}','verified')`);
  await c.query(`insert into provider_usage (listing_id, caller_user_id, shar, created_at) values ('11111111-1111-1111-1111-111111111111','U2',3,'${iso(day(1))}'),('11111111-1111-1111-1111-111111111111','U2',0,'${iso(day(1))}')`);
  sum = await s.getSummary('U1', NOW);
  check('provider: usage Shar added (145 + 3 = 148)', sum.available === 148 && sum.provider.earned === 3 && sum.provider.owned === 1, sum.available);
  check('provider: usage appears in activity', sum.activity.some((a) => a.kind === 'provider' && a.shar === 3));

  // claims
  check('claim: below minimum refused', (await s.createClaim('U1', { shar: 49, wallet: WALLET })).status === 400);
  check('claim: bad wallet refused', (await s.createClaim('U1', { shar: 50, wallet: 'nope' })).status === 400);
  check('claim: more than available refused', (await s.createClaim('U1', { shar: 9999, wallet: WALLET })).status === 400);
  check('claim: fractional/NaN refused', (await s.createClaim('U1', { shar: 50.5, wallet: WALLET })).status === 400 && (await s.createClaim('U1', { shar: 'x', wallet: WALLET })).status === 400);
  const ok = await s.createClaim('U1', { shar: 100, wallet: WALLET });
  check('claim: valid claim accepted with fixed SKR', ok.ok === true && ok.claim.skr === '90', JSON.stringify(ok).slice(0, 80));
  check('claim: second open claim refused', (await s.createClaim('U1', { shar: 50, wallet: WALLET })).status === 409);
  sum = await s.getSummary('U1', NOW);
  check('claim: available drops by the claim (148 - 100 = 48); lifetime unchanged', sum.available === 48 && sum.lifetime === 148, `${sum.available}/${sum.lifetime}`);
  check('claim: open claim is reported', sum.claim.open && sum.claim.open.shar === 100);
  check('claim: shows in activity as negative', sum.activity.find((a) => a.kind === 'claim')?.shar === -100);
  await c.query(`update shar_claims set status='rejected' where user_id='U1'`);
  sum = await s.getSummary('U1', NOW);
  check('claim: a rejected claim returns the Shar (back to 148)', sum.available === 148, sum.available);
  // two taps at once: only one claim may exist
  const [a, b] = await Promise.all([s.createClaim('U1', { shar: 60, wallet: WALLET }), s.createClaim('U1', { shar: 60, wallet: WALLET })]);
  const created = [a, b].filter((x) => x.ok).length;
  const open = (await c.query(`select count(*)::int as n from shar_claims where user_id='U1' and status='requested'`)).rows[0].n;
  check('claim: two simultaneous taps create exactly one claim', open === 1 && created === 1, `created=${created} open=${open}`);

  // leaderboard
  await addPay(c, 'U3', 'bill', 'completed', '300', day(1));
  const lb = await s.getLeaderboard('U1', NOW);
  check('leaderboard: ordered by this week (U3 300, U2 205, U1 28)', lb.top.map((t) => t.shar).join(',') === '300,205,28', lb.top.map((t) => t.shar).join(','));
  check('leaderboard: marks me and ranks me 3rd', lb.top[2].you === true && lb.me.rank === 3 && lb.me.shar === 28, JSON.stringify(lb.me));
  check('leaderboard: shows anonymous handles only', lb.top.every((t) => /^Seeker [0-9A-F]{4}$/.test(t.handle)) && !JSON.stringify(lb).includes('U3'));
  check('leaderboard: last week (U1 investment 100) is excluded', !lb.top.some((t) => t.shar === 100));
  const lbLater = await s.getLeaderboard('U1', new Date('2026-10-12T00:00:01Z')); // next Monday: everything resets
  check('leaderboard: resets on Monday 00:00 UTC', lbLater.top.length === 0 && lbLater.me.rank === null);

  // before the migration is applied: spending half still works, nothing throws
  const bare = await freshDb({ migrate: false });
  await addPay(bare.client, 'U1', 'bill', 'completed', '60', day(1));
  const bs = await bare.shar.getSummary('U1', NOW);
  check('no migration: summary still works from payments (60) and says not ready', bs.available === 60 && bs.ready === false && bs.referral.code === null, `${bs.available} ready=${bs.ready}`);
  const bl = await bare.shar.getLeaderboard('U1', NOW);
  check('no migration: leaderboard falls back to spending only', bl.top.length === 1 && bl.top[0].shar === 60);
  check('no migration: claiming says "being set up" (503)', (await bare.shar.createClaim('U1', { shar: 50, wallet: WALLET })).status === 503);

  finish();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
