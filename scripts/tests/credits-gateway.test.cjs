/**
 * Credits, paid provider calls, commission and withdrawals. The real src/lib code on an in-memory Postgres built from the real
 * migrations. The provider's own server is simulated through runProviderCall's `call` argument.
 *
 *     node scripts/tests/credits-gateway.test.cjs
 */
const { makeLoader, freshDb, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const cents = (n) => n * 10_000; // $0.01 in micro-USDC

(async () => {
  const { client, db } = await freshDb();
  const load = makeLoader({
    "@/lib/db": { db },
    "@/lib/server-env": { getServerEnv: () => undefined },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
  });
  const credits = load("src/lib/credits.ts");
  const earnings = load("src/lib/earnings.ts");
  const net = load("src/lib/provider-network.ts");
  const rules = load("src/lib/payments-rules.ts");

  const q = async (text, params = []) => (await client.query(text, params)).rows;
  const balance = async (u) => Number((await q(`select balance_micro from credit_balances where user_id = $1`, [u]))[0]?.balance_micro ?? 0);
  const earned = async (u) => (await q(`select available_micro, lifetime_micro from earnings_balances where user_id = $1`, [u]))[0] ?? { available_micro: 0, lifetime_micro: 0 };
  const ledger = async (u, kind) => (await q(`select * from credit_ledger where user_id = $1 and kind = $2 order by created_at`, [u, kind]));

  // A verified paid listing owned by OWNER, priced $0.05; and a free one.
  const mk = async (owner, name, price) => {
    const r = await net.createListing(owner, { name, summary: "Does something useful for testing.", category: "data", endpointUrl: "https://api.example.com/v1", priceUsdc: price, payoutWallet: WALLET });
    if (!r.ok) throw new Error(r.error);
    await net.reviewListing(r.listing.id, "verify", null);
    return net.getListing(r.listing.id);
  };
  const paid = await mk("OWNER", "Paid Wisp", "0.05");
  const free = await mk("OWNER", "Free Wisp", "0");
  const okCall = async () => ({ ok: true, status: 200, body: { answer: 42 } });

  // ── top-ups
  const t1 = await credits.creditTopup("CALLER", "sig-ONE", 1_000_000);
  check("a top-up credits the balance", t1.credited === true && t1.balanceMicro === 1_000_000 && (await balance("CALLER")) === 1_000_000);
  const t2 = await credits.creditTopup("CALLER", "sig-ONE", 1_000_000);
  check("the SAME deposit signature is never credited twice", t2.credited === false && t2.balanceMicro === 1_000_000 && (await ledger("CALLER", "topup")).length === 1);
  const t3 = await credits.creditTopup("CALLER", "sig-TWO", 2_500_000);
  check("a second, different deposit adds up (3.5)", t3.credited && t3.balanceMicro === 3_500_000);
  let threw = false;
  try { await credits.creditTopup("CALLER", "sig-DUST", 999_999); } catch { threw = true; }
  check("a deposit below the $1 minimum is refused", threw && (await balance("CALLER")) === 3_500_000);

  // ── a paid call: debit, call, settle 80/20
  const r1 = await net.runProviderCall(paid, "CALLER", {}, okCall);
  check("a paid call succeeds and charges $0.05", r1.ok && r1.chargedMicro === 50_000 && r1.data.answer === 42, JSON.stringify(r1).slice(0, 90));
  check("the caller's balance dropped by exactly the price (3,450,000)", (await balance("CALLER")) === 3_450_000);
  const e1 = await earned("OWNER");
  check("the owner earned 80% = 40,000 micro-USDC", Number(e1.available_micro) === 40_000 && Number(e1.lifetime_micro) === 40_000);
  const u1 = (await q(`select paid_micro, owner_micro, platform_micro, settlement_ref, caller_user_id from provider_usage where paid_micro > 0`))[0];
  check("the usage row records the split and sums to the price", Number(u1.paid_micro) === 50_000 && Number(u1.owner_micro) === 40_000 && Number(u1.platform_micro) === 10_000);
  const callRow = (await ledger("CALLER", "call"))[0];
  check("the usage row carries the debit's ledger id (so it can't be mistaken for an orphan)", u1.settlement_ref === callRow.id && Number(callRow.amount_micro) === -50_000);

  // ── failures never cost the caller anything
  const before = await balance("CALLER");
  for (const [label, fakeCall] of [
    ["provider unreachable", async () => ({ ok: false, status: 502, error: "The provider didn't answer in time." })],
    ["provider returns 500", async () => ({ ok: true, status: 500, body: { error: "boom" } })],
    ["provider returns 404", async () => ({ ok: true, status: 404, body: "nope" })],
    ["provider call throws", async () => { throw new Error("socket hang up"); }],
  ]) {
    const r = await net.runProviderCall(paid, "CALLER", {}, fakeCall);
    check(`${label}: refused with a plain message, "You weren't charged."`, !r.ok && /weren't charged/.test(r.error), r.error);
  }
  check("after four failures the balance is exactly what it was", (await balance("CALLER")) === before);
  check("each failure left a debit AND exactly one refund in the ledger", (await ledger("CALLER", "refund")).length === 4);
  const e2 = await earned("OWNER");
  check("failed calls earned the owner nothing", Number(e2.available_micro) === 40_000);
  check("failed calls left no usage rows", Number((await q(`select count(*) n from provider_usage where paid_micro > 0`))[0].n) === 1);

  // ── no credits -> 402, and nothing happens
  const poor = await net.runProviderCall(paid, "BROKE", {}, async () => { throw new Error("must not be called"); });
  check("no credits: 402 insufficient_credits with the price and balance", !poor.ok && poor.status === 402 && poor.code === "insufficient_credits" && poor.requiredMicro === 50_000 && poor.balanceMicro === 0, JSON.stringify(poor));
  check("the provider is NOT called when the caller can't pay", poor.error.includes("0.05"));

  // ── the owner testing their own paid listing is free and earns nothing
  const own = await net.runProviderCall(paid, "OWNER", {}, okCall);
  check("the owner can test their own paid provider free of charge", own.ok && own.chargedMicro === 0);
  check("...and it earns neither credits movement nor commission", (await balance("OWNER")) === 0 && Number((await earned("OWNER")).available_micro) === 40_000);

  // ── free listings work as before
  const fr = await net.runProviderCall(free, "BROKE", {}, okCall);
  check("a free provider needs no credits", fr.ok && fr.chargedMicro === 0 && fr.balanceMicro === null);

  // ── an invalid stored price is refused rather than guessed at
  const badPrice = { ...paid, priceUsdc: "5.0000001" };
  check("a corrupt price is refused (500), never charged", (await net.runProviderCall(badPrice, "CALLER", {}, okCall)).status === 500);

  // ── concurrency: 10 calls at once against $0.25 can only succeed 5 times
  await credits.creditTopup("RACER", "sig-RACE", 1_000_000);
  await q(`update credit_balances set balance_micro = 250000 where user_id = 'RACER'`);
  const burst = await Promise.all(Array.from({ length: 10 }, () => net.runProviderCall(paid, "RACER", {}, okCall)));
  const won = burst.filter((r) => r.ok).length;
  const refused = burst.filter((r) => !r.ok && r.status === 402).length;
  check("10 simultaneous $0.05 calls on a $0.25 balance: exactly 5 succeed and 5 are refused", won === 5 && refused === 5, `${won}/${refused}`);
  check("the balance ends at exactly 0, never negative", (await balance("RACER")) === 0);
  let negativeBlocked = false;
  try { await q(`update credit_balances set balance_micro = -1 where user_id = 'RACER'`); } catch { negativeBlocked = true; }
  check("the database itself refuses a negative balance (CHECK constraint)", negativeBlocked);

  // ── the books always balance: every paid micro-USDC is owner + Bluvfi, and ledger debits match usage
  const tot = (await q(`select coalesce(sum(paid_micro),0) p, coalesce(sum(owner_micro),0) o, coalesce(sum(platform_micro),0) pl, count(*) n from provider_usage where paid_micro > 0`))[0];
  check("across all usage: owner + Bluvfi = paid, exactly", Number(tot.o) + Number(tot.pl) === Number(tot.p), `${tot.o}+${tot.pl} vs ${tot.p}`);
  const debited = Number((await q(`select coalesce(-sum(amount_micro),0) d from credit_ledger where kind = 'call'`))[0].d);
  const refundedTotal = Number((await q(`select coalesce(sum(amount_micro),0) r from credit_ledger where kind = 'refund'`))[0].r);
  check("money in = money out: debits - refunds = what was settled", debited - refundedTotal === Number(tot.p), `${debited}-${refundedTotal} vs ${tot.p}`);
  check("every settled micro-USDC reached the owner's earnings (80%)", Number((await earned("OWNER")).lifetime_micro) === Number(tot.o));

  // ── a refund can only happen once
  const call2 = await credits.debitForCall("CALLER", paid.id, 50_000);
  const rf1 = await credits.refundCall("CALLER", call2.ledgerId, 50_000);
  const rf2 = await credits.refundCall("CALLER", call2.ledgerId, 50_000);
  check("refunding the same call twice credits it only once", rf1.refunded === true && rf2.refunded === false);

  // ── orphans: charged, then the server died. They are refunded once they're old enough, and settled calls never are.
  const orphan = await credits.debitForCall("CALLER", paid.id, 50_000);
  const balBefore = await balance("CALLER");
  check("a fresh in-flight call is not swept (it may still be running)", (await credits.sweepOrphanCalls("CALLER", 3 * 60_000)) === 0 && (await balance("CALLER")) === balBefore);
  await q(`update credit_ledger set created_at = now() - interval '10 minutes' where id = $1`, [orphan.ledgerId]);
  const swept = await credits.sweepOrphanCalls("CALLER", 3 * 60_000);
  check("an old orphaned charge is refunded", swept === 1 && (await balance("CALLER")) === balBefore + 50_000, String(swept));
  check("sweeping again does nothing (no double refund)", (await credits.sweepOrphanCalls("CALLER", 0)) === 0);
  await q(`update credit_ledger set created_at = now() - interval '10 minutes' where user_id = 'CALLER'`);
  const balAfter = await balance("CALLER");
  await credits.sweepOrphanCalls("CALLER", 0);
  check("settled calls are never swept, however old", (await balance("CALLER")) === balAfter);

  // ── withdrawals
  check("below the $5 minimum a withdrawal is refused", (await earnings.requestWithdrawal("OWNER", WALLET)).status === 400);
  for (const bad of ["nope", "", "11111111111111111111111111111111", rules.SKR_MINT]) {
    await q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ('RICH', 9000000, 9000000) on conflict (user_id) do update set available_micro = 9000000`);
    const r = await earnings.requestWithdrawal("RICH", bad);
    check(`withdrawal to ${JSON.stringify(bad).slice(0, 24)} is refused and the balance is untouched`, !r.ok && r.status === 400 && Number((await earned("RICH")).available_micro) === 9_000_000);
  }
  const w = await earnings.requestWithdrawal("RICH", WALLET);
  check("a withdrawal moves the WHOLE balance into one payout request", w.ok && w.payout.usdMicro === 9_000_000 && Number((await earned("RICH")).available_micro) === 0, JSON.stringify(w).slice(0, 80));
  const w2 = await earnings.requestWithdrawal("RICH", WALLET);
  check("asking again with nothing left is refused", !w2.ok && w2.status === 400);
  await q(`update earnings_balances set available_micro = 7000000 where user_id = 'RICH'`);
  const w3 = await earnings.requestWithdrawal("RICH", WALLET);
  check("a second request while one is open is refused (409)...", !w3.ok && w3.status === 409);
  check("...and the refused attempt did NOT touch the balance (the statement is atomic)", Number((await earned("RICH")).available_micro) === 7_000_000);
  const summary = await earnings.getEarnings("RICH");
  check("the summary shows the open payout and blocks a new withdrawal", summary.open && summary.open.usdMicro === 9_000_000 && summary.canWithdraw === false && summary.ownerPct === 80);

  // ── two simultaneous withdrawals can only ever create one payout
  await q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ('TWIN', 6000000, 6000000)`);
  const twin = await Promise.all([earnings.requestWithdrawal("TWIN", WALLET), earnings.requestWithdrawal("TWIN", WALLET)]);
  check("two simultaneous withdrawals create exactly one payout", twin.filter((x) => x.ok).length === 1 && Number((await q(`select count(*) n from commission_payouts where user_id = 'TWIN'`))[0].n) === 1);

  finish();
})().catch((e) => {
  console.error("TEST HARNESS ERROR", e);
  process.exit(1);
});
