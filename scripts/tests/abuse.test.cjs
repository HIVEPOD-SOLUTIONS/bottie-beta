/**
 * Abuse controls beyond one account: linking accounts by phone and by payout wallet, the per-phone claim limit, referrals and
 * provider use between accounts on the same phone, and the acknowledgement an admin must give before paying a linked account.
 * The real src/lib code on an in-memory Postgres built from the real migrations; the chain is simulated.
 *
 *     node scripts/tests/abuse.test.cjs
 */
const { makeLoader, freshDb, reporter } = require("./_harness.cjs");
const { fakeChain } = require("./_fakechain.cjs");
const { check, finish } = reporter();

const W1 = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const W2 = "DKL92bJrYVWKLsmmw8NDGjSsEc5Xc8LzJbP1JEnDVSoF".slice(0, 44);
const W3 = "BLuvF1DepositAddress11111111111111111111111";
const W4 = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
// Real, payable wallets (token mint addresses are refused as payout destinations).
const { Keypair } = require("@solana/web3.js");
const W5 = Keypair.generate().publicKey.toBase58();
const W6 = Keypair.generate().publicKey.toBase58();
const W7 = Keypair.generate().publicKey.toBase58(); // used by exactly one account

(async () => {
  const { client, db } = await freshDb();
  const load = makeLoader({
    "@/lib/db": { db },
    "@/lib/server-env": { getServerEnv: () => undefined },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
  });
  const rules = load("src/lib/abuse-rules.ts");
  const abuse = load("src/lib/abuse.ts");
  const shar = load("src/lib/shar.ts");
  const earnings = load("src/lib/earnings.ts");
  const net = load("src/lib/provider-network.ts");
  const payout = load("src/lib/skr-payout.ts");
  const admin = load("src/lib/admin.ts");
  const q = async (text, params = []) => (await client.query(text, params)).rows;
  const phone = (n) => `android:abcdef012345${n}`;

  // ── the pure rules ────────────────────────────────────────────────────────
  const h = rules.deviceHash;
  check("device hash: a usable id gives a 64-char hex hash", /^[0-9a-f]{64}$/.test(h(phone(1))));
  check("device hash: the same id hashes the same, different ids differ, whitespace is ignored", h(phone(1)) === h(`  ${phone(1)} `) && h(phone(1)) !== h(phone(2)));
  check("device hash: the raw id is not recoverable from it", !h(phone(1)).includes("abcdef012345"));
  check("device hash: missing, short, long, non-string or control-character ids are refused", h(undefined) === null && h("") === null && h("short") === null && h("x".repeat(201)) === null && h(12345678) === null && h("abcdefgh\u0000ij") === null);
  const rf = rules.riskFlags;
  check("flags: nothing linked -> no flags", rf({ otherAccountsOnDevice: 0, otherAccountsOnWallet: 0, linkedPaidAccounts: 0 }).length === 0);
  check("flags: each link raises its own flag", rf({ otherAccountsOnDevice: 1, otherAccountsOnWallet: 0, linkedPaidAccounts: 0 }).join() === "shared_device" && rf({ otherAccountsOnDevice: 0, otherAccountsOnWallet: 2, linkedPaidAccounts: 0 }).join() === "shared_wallet" && rf({ otherAccountsOnDevice: 1, otherAccountsOnWallet: 1, linkedPaidAccounts: 1 }).join() === "shared_device,shared_wallet,linked_paid");
  check("claim limit: one other claiming account is fine, two is over", !rules.overDeviceClaimLimit(1) && rules.overDeviceClaimLimit(2) && rules.overDeviceClaimLimit(5));

  // ── remembering phones ────────────────────────────────────────────────────
  await abuse.recordDevice("D1", phone(1));
  await abuse.recordDevice("D1", phone(1));
  const rows = await q(`select * from user_devices where user_id = 'D1'`);
  check("record: one row per (account, phone), however often it is seen", rows.length === 1);
  check("record: only the hash is stored, never the raw id", rows[0].device_hash === h(phone(1)) && !JSON.stringify(rows).includes("abcdef012345"));
  await abuse.recordDevice("D2", "tiny");
  await abuse.recordDevice("D2", undefined);
  check("record: unusable ids are ignored silently", (await q(`select 1 from user_devices where user_id = 'D2'`)).length === 0);
  for (let i = 0; i < 12; i++) await abuse.recordDevice("D3", phone(100 + i));
  const kept = (await q(`select device_hash from user_devices where user_id = 'D3'`)).map((r) => r.device_hash);
  check("record: an account keeps at most 8 phones, the most recent ones", kept.length === 8 && kept.includes(h(phone(111))) && !kept.includes(h(phone(100))), `kept=${kept.length}`);
  await abuse.noteDevice({ headers: { get: (n) => (n === "x-bluvfi-device" ? phone(7) : null) } }, "D4");
  check("record: noteDevice reads the app's X-Bluvfi-Device header", (await q(`select 1 from user_devices where user_id = 'D4' and device_hash = $1`, [h(phone(7))])).length === 1);

  // ── sharing a phone ───────────────────────────────────────────────────────
  await abuse.recordDevice("A", phone(20));
  await abuse.recordDevice("B", phone(20));
  await abuse.recordDevice("C", phone(21));
  check("shares a phone: two accounts on one phone", (await abuse.sharesDevice("A", "B")) === true && (await abuse.sharesDevice("B", "A")) === true);
  check("shares a phone: different phones, an unknown account, and the same account", (await abuse.sharesDevice("A", "C")) === false && (await abuse.sharesDevice("A", "NOBODY")) === false && (await abuse.sharesDevice("A", "A")) === true);

  // ── at most a few accounts can claim from one phone ───────────────────────
  const money = (u, usd = 2000) => q(`insert into payments (user_id, type, status, amount_usdc, description) values ($1, 'bill', 'completed', $2, 'Gift card')`, [u, String(usd)]);
  const phoneUsers = ["P1", "P2", "P3", "P4"];
  for (const u of phoneUsers) { await abuse.recordDevice(u, phone(30)); await money(u); }
  const claim = (u, wallet) => shar.createClaim(u, { shar: 1000, wallet });
  const c1 = await claim("P1", W1);
  const c2 = await claim("P2", W2);
  check("phone limit: the first two accounts on a phone can claim", c1.ok && c2.ok);
  const c3 = await claim("P3", W3);
  check("phone limit: the THIRD account on the same phone is refused (409) and nothing is created", !c3.ok && c3.status === 409 && /phone/.test(c3.error) && (await q(`select 1 from shar_claims where user_id = 'P3'`)).length === 0, JSON.stringify(c3));
  await q(`update shar_claims set status = 'rejected' where id = $1`, [c1.claim.id]);
  const c3b = await claim("P3", W3);
  check("phone limit: a declined claim no longer counts, so room opens up", c3b.ok === true, JSON.stringify(c3b));
  await money("Z1");
  check("phone limit: an account on another phone is unaffected", (await claim("Z1", W4)).ok === true);
  await money("N1");
  check("phone limit: an account with no phone on record is never blocked by it", (await claim("N1", W5)).ok === true);

  // the same limit for commission withdrawals, and claims and withdrawals count together
  const wd = (u, wallet) => earnings.requestWithdrawal(u, wallet);
  const give = (u) => q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ($1, 9000000, 9000000) on conflict (user_id) do update set available_micro = 9000000`, [u]);
  for (const u of ["Q1", "Q2", "Q3"]) { await abuse.recordDevice(u, phone(40)); await give(u); }
  check("phone limit (withdrawals): two accounts can withdraw", (await wd("Q1", W1)).ok && (await wd("Q2", W2)).ok);
  const w3 = await wd("Q3", W3);
  check("phone limit (withdrawals): the third is refused and its balance is untouched", !w3.ok && w3.status === 409 && Number((await q(`select available_micro from earnings_balances where user_id = 'Q3'`))[0].available_micro) === 9_000_000, JSON.stringify(w3));
  await abuse.recordDevice("Q4", phone(40)); await money("Q4");
  check("phone limit: claims and withdrawals add up (two withdrawers already on this phone)", !(await claim("Q4", W4)).ok);

  // ── referrals between accounts on the same phone ──────────────────────────
  const code = async (u) => (await shar.ensureProfile(u)).referralCode;
  await abuse.recordDevice("R1", phone(50));
  await abuse.recordDevice("R2", phone(50));
  await abuse.recordDevice("R3", phone(51));
  const r2 = await shar.attachReferral("R2", await code("R1"));
  check("referral: a code from an account on the same phone is refused", !r2.ok && r2.status === 400 && /same phone/.test(r2.error), JSON.stringify(r2));
  check("referral: ...and nothing was recorded", (await q(`select referred_by from shar_profiles where user_id = 'R2'`))[0]?.referred_by == null);
  check("referral: a friend on a different phone can use it", (await shar.attachReferral("R3", await code("R1"))).ok === true);
  check("referral: an account with no phone on record can use it (we can't know)", (await shar.attachReferral("R9", await code("R1"))).ok === true);

  // ── provider use between accounts on the same phone earns nothing ─────────
  const mk = async (owner, name) => {
    const r = await net.createListing(owner, { name, summary: "Does something useful for testing.", category: "data", endpointUrl: "https://api.example.com/v1", priceUsdc: "0", payoutWallet: W1 });
    if (!r.ok) throw new Error(r.error);
    await net.reviewListing(r.listing.id, "verify", null);
    return net.getListing(r.listing.id);
  };
  await abuse.recordDevice("OWN", phone(60));
  await abuse.recordDevice("ALT", phone(60));
  await abuse.recordDevice("FRIEND", phone(61));
  const listing = await mk("OWN", "Farm Wisp");
  check("provider use: the owner's second account on the same phone earns the owner NOTHING", (await net.recordUsage(listing, "ALT")).shar === 0);
  check("provider use: someone on another phone still earns the owner Shar", (await net.recordUsage(listing, "FRIEND")).shar === 1);
  check("provider use: a caller with no phone on record still earns it", (await net.recordUsage(listing, "STRANGER")).shar === 1);

  // ── assessing risk ────────────────────────────────────────────────────────
  let risk = await abuse.assessRisk("CLEAN", W6);
  check("risk: an unlinked account with no phone is clean, with a note that no phone is on record", risk.flags.length === 0 && risk.info.join() === "no_device" && risk.linkedAccounts === 0 && risk.deviceChecks === true);
  await abuse.recordDevice("CLEAN", phone(70));
  risk = await abuse.assessRisk("CLEAN", W6);
  check("risk: once a phone is on record the note goes away", risk.flags.length === 0 && risk.info.length === 0);
  await money("S1"); await claim("S1", W6); // S1 asks for a payout to W6
  risk = await abuse.assessRisk("CLEAN", W6);
  check("risk: another account asking for the same wallet raises shared_wallet", risk.flags.join() === "shared_wallet" && risk.linkedAccounts === 1, JSON.stringify(risk));
  await q(`update shar_claims set status = 'rejected' where user_id = 'S1'`);
  check("risk: a declined request to that wallet no longer counts", (await abuse.assessRisk("CLEAN", W6)).flags.length === 0);
  await abuse.recordDevice("L1", phone(70));
  risk = await abuse.assessRisk("CLEAN", W6);
  check("risk: another account on the same phone raises shared_device", risk.flags.join() === "shared_device" && risk.linkedAccounts === 1);
  await q(`insert into shar_claims (user_id, shar, skr_amount, wallet, status) values ('L1', 1000, '900', $1, 'paid')`, [W2]);
  risk = await abuse.assessRisk("CLEAN", W6);
  check("risk: a linked account that was already paid raises linked_paid", risk.flags.join() === "shared_device,linked_paid", JSON.stringify(risk.flags));

  // ── the payout needs an acknowledgement when flagged ──────────────────────
  const WL = "H3LiuMfFcWrnCmNN8M5E3jxYdQ4LpHLC5v1WJ6dmDfiB".slice(0, 44);
  const pay = async (u, wallet) => { await money(u); const c = await claim(u, wallet); if (!c.ok) throw new Error(c.error); return c.claim.id; };
  const wUser = await pay("X1", WL); // X1 and X2 both ask for the same wallet
  const wUser2 = await pay("X2", WL);
  const chain = fakeChain();
  const refused = await payout.payPayout({ kind: "shar_claim", id: wUser2 }, chain);
  check("payout: a flagged payout is refused without acknowledgement (409 risk_unacknowledged) and carries the flags", !refused.ok && refused.status === 409 && refused.code === "risk_unacknowledged" && refused.risk.flags.includes("shared_wallet"), JSON.stringify(refused).slice(0, 140));
  check("payout: ...nothing was sent and it is still waiting in the queue", chain.state.sent.length === 0 && (await q(`select status from shar_claims where id = $1`, [wUser2]))[0].status === "requested");
  const quote = await payout.quotePayout("shar_claim", wUser2, chain);
  check("payout: the quote tells the admin about the link", quote.risk.flags.includes("shared_wallet") && quote.risk.linkedAccounts >= 1);
  const ack = await payout.payPayout({ kind: "shar_claim", id: wUser2, acknowledgeRisk: true }, chain);
  check("payout: with the admin's acknowledgement it is sent, and the acknowledged flags are reported", ack.ok && chain.state.sent.length === 1 && ack.acknowledged.includes("shared_wallet"), JSON.stringify(ack).slice(0, 140));
  const clean = await pay("X9", W7);
  await abuse.recordDevice("X9", phone(80));
  const cleanPaid = await payout.payPayout({ kind: "shar_claim", id: clean }, chain);
  check("payout: an unlinked account pays with no acknowledgement and nothing to acknowledge", cleanPaid.ok && cleanPaid.acknowledged.length === 0, JSON.stringify(cleanPaid).slice(0, 120));

  // ── what the admin sees ───────────────────────────────────────────────────
  const queue = await admin.getQueue(chain);
  const waiting = queue.payouts.waiting.find((p) => p.id === wUser);
  check("queue: a waiting payout shows its risk (X1 is linked to X2 by wallet)", waiting && waiting.risk && waiting.risk.flags.includes("shared_wallet"), JSON.stringify(waiting && waiting.risk));
  check("queue: payouts that are already paid carry no risk check", queue.payouts.paid.every((p) => p.risk === null));

  // ── when the device table isn't there yet nothing breaks ──────────────────
  await client.exec(`drop table user_devices`);
  await abuse.recordDevice("M1", phone(90));
  check("no table: recording a phone doesn't throw", true);
  check("no table: no phone link and no phone limit apply", (await abuse.sharesDevice("A", "B")) === false && (await abuse.claimBlockedByDevice("P3")) === false);
  const noTable = await abuse.assessRisk("CLEAN", W6);
  check("no table: the risk check still runs on wallets and says the phone checks aren't set up", noTable.deviceChecks === false && Array.isArray(noTable.flags), JSON.stringify(noTable));
  await money("M2");
  check("no table: claims still work", (await claim("M2", W4)).ok === true);

  finish();
})().catch((e) => {
  process.stderr.write(`ABUSE TEST CRASHED ${(e && e.stack) || e}\n`);
  process.exit(2);
});
