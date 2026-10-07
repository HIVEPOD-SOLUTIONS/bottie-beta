/**
 * SKR payouts. The real src/lib/skr-payout.ts on an in-memory Postgres, against a SIMULATED chain that signs with a real
 * keypair and records exactly what would be broadcast. Every transaction is decoded and checked (who gets how much SKR),
 * and every failure that could cause a double payment is simulated.
 *
 *     node scripts/tests/skr-payout.test.cjs
 */
const { makeLoader, freshDb, reporter, req } = require("./_harness.cjs");
const { check, finish } = reporter();

const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");
const bs58 = ((m) => m.default ?? m)(req("bs58")); // bs58 exposes encode/decode under .default

const SKR = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const WALLET2 = "DKL92bJrYVWKLsmmw8NDGjSsEc5Xc8LzJbP1JEnDVSoF".slice(0, 44);

const { fakeChain, decode } = require("./_fakechain.cjs");

(async () => {
  const { client, db } = await freshDb();
  const load = makeLoader({ "@/lib/db": { db }, "@/lib/server-env": { getServerEnv: () => undefined } });
  const payout = load("src/lib/skr-payout.ts");
  const shar = load("src/lib/shar.ts");
  const earnings = load("src/lib/earnings.ts");
  const rules = load("src/lib/payments-rules.ts");

  const q = async (text, params = []) => (await client.query(text, params)).rows;
  const row = async (table, id) => (await q(`select * from ${table} where id = $1`, [id]))[0];
  const ataOf = (owner) => spl.getAssociatedTokenAddressSync(new web3.PublicKey(SKR), new web3.PublicKey(owner), true).toBase58();

  const makeClaim = async (user, usd = 2000) => {
    await q(`insert into payments (user_id, type, status, amount_usdc, description) values ($1, 'bill', 'completed', $2, 'Gift card')`, [user, String(usd)]);
    const r = await shar.createClaim(user, { shar: 1000, wallet: WALLET });
    if (!r.ok) throw new Error("claim failed: " + r.error);
    return r.claim.id;
  };
  const makeWithdrawal = async (user, usdMicro = 9_000_000, wallet = WALLET) => {
    await q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ($1, $2, $2) on conflict (user_id) do update set available_micro = $2`, [user, usdMicro]);
    const r = await earnings.requestWithdrawal(user, wallet);
    if (!r.ok) throw new Error("withdraw failed: " + r.error);
    return r.payout.id;
  };

  // ── 1. A Shar claim: 1,000 Shar = 900 SKR, fixed when it was claimed
  {
    const chain = fakeChain();
    const id = await makeClaim("A1");
    const quote = await payout.quotePayout("shar_claim", id, chain);
    check("the claim quote is the fixed 900 SKR (no market price involved)", quote.skr === "900" && quote.usdPerSkr === null && quote.treasury.skr === "1000000");
    const res = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, chain);
    check("paying a Shar claim succeeds", res.ok && res.status === "paid", JSON.stringify(res).slice(0, 100));
    const d = decode(chain.state.sent[0], chain.treasury.publicKey);
    check("exactly one transaction was broadcast", chain.state.sent.length === 1);
    check("it moves EXACTLY 900 SKR (900,000,000 base units, 6 decimals)", d.amount === 900_000_000n && d.decimals === 6, String(d.amount));
    check("of the SKR mint", d.mint === SKR);
    check("from the treasury's token account to the recipient's token account", d.source === ataOf(chain.treasuryAddress()) && d.dest === ataOf(WALLET), `${d.dest} vs ${ataOf(WALLET)}`);
    check("authorised and fee-paid by the treasury, with a valid signature", d.authority === chain.treasuryAddress() && d.feePayer === chain.treasuryAddress() && d.signerIsTreasury && d.sigValid);
    check("it first creates the recipient's token account if needed (idempotent), then transfers, then a memo", d.count === 3 && d.first === spl.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    check("the memo names the payout so it can be found on-chain", d.memo === `bluvfi:shar_claim:${id}`, d.memo);
    const r = await row("shar_claims", id);
    check("the claim is paid, with the SAME signature that was broadcast", r.status === "paid" && r.tx_signature === d.signature && r.paid_at !== null);
    check("the claim kept its Shar spent (balance stays reduced)", (await shar.getSummary("A1")).available === 1000);
    const again = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, chain);
    check("paying a paid claim again is refused and sends nothing", !again.ok && again.status === 409 && chain.state.sent.length === 1);
  }

  // ── 2. Commission: priced at click time, and the admin's reviewed amount is enforced
  {
    const chain = fakeChain();
    const id = await makeWithdrawal("B1", 9_000_000);
    const quote = await payout.quotePayout("commission", id, chain);
    check("commission quote: $9 at $0.0176/SKR is about 511.36 SKR", quote.skrMicro === Math.round(9_000_000 / 0.0176) && quote.usdPerSkr === "0.0176", `${quote.skr} / ${quote.usdPerSkr}`);
    const noReview = await payout.payPayout({ acknowledgeRisk: true, kind: "commission", id }, chain);
    check("commission can't be paid without a reviewed amount", !noReview.ok && noReview.code === "quote_required" && chain.state.sent.length === 0);
    check("...and it is still waiting afterwards", (await row("commission_payouts", id)).status === "requested");

    // price moves 10% between review and click
    chain.state.quote = (usd) => ({ skrMicro: Math.round(usd / 0.0160), priceImpactPct: 0.01 });
    const moved = await payout.payPayout({ acknowledgeRisk: true, kind: "commission", id, expectedSkrMicro: quote.skrMicro }, chain);
    check("a 10% price move since the review: refused (409) with the new amount, nothing sent", !moved.ok && moved.code === "price_moved" && moved.quote && chain.state.sent.length === 0, moved.code);
    check("...and the payout is back in the queue for a fresh review", (await row("commission_payouts", id)).status === "requested");

    // small drift (1%) is within tolerance
    chain.state.quote = (usd) => ({ skrMicro: Math.round(usd / 0.01776), priceImpactPct: 0.01 });
    const ok = await payout.payPayout({ acknowledgeRisk: true, kind: "commission", id, expectedSkrMicro: quote.skrMicro }, chain);
    check("a 1% drift is within tolerance and the payout goes through", ok.ok && ok.status === "paid", JSON.stringify(ok).slice(0, 90));
    const d = decode(chain.state.sent[0], chain.treasury.publicKey);
    check("it sends the amount priced at click time, not the older review amount", d.amount === BigInt(Math.round(9_000_000 / 0.01776)), String(d.amount));
    const r = await row("commission_payouts", id);
    check("the payout records the SKR amount and the price used", Number(r.skr_micro) === Math.round(9_000_000 / 0.01776) && r.usd_per_skr === "0.01776" && r.status === "paid", `${r.skr_micro} @ ${r.usd_per_skr}`);
    check("the owner's balance stays at 0 (the money was paid out, not returned)", Number((await q(`select available_micro from earnings_balances where user_id = 'B1'`))[0].available_micro) === 0);
  }

  // ── 3. Two admins click at once: only one payment
  {
    const chain = fakeChain();
    const id = await makeClaim("C1");
    const [a, b] = await Promise.all([payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, chain), payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, chain)]);
    check("two simultaneous clicks: exactly one payout is sent", chain.state.sent.length === 1 && [a, b].filter((x) => x.ok).length === 1, `sent=${chain.state.sent.length}`);
    check("the other click is told it was already taken (409)", [a, b].some((x) => !x.ok && x.status === 409));
  }

  // ── 4. Safety limits: nothing is sent, and the payout goes back to the queue
  {
    const small = fakeChain({ skr: 100_000_000 }); // only 100 SKR in the treasury
    const id = await makeClaim("D1");
    const r1 = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, small);
    check("treasury without enough SKR: refused (409), nothing sent", !r1.ok && r1.code === "treasury_low_skr" && small.state.sent.length === 0);
    check("...and the claim is back in the queue with a reason", (await row("shar_claims", id)).status === "requested" && /enough SKR/.test((await row("shar_claims", id)).note));

    const nosol = fakeChain({ lamports: 1_000 });
    const r2 = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, nosol);
    check("treasury without SOL for fees: refused, nothing sent", !r2.ok && r2.code === "treasury_low_sol" && nosol.state.sent.length === 0);

    // single payout limit: a $500,000 commission at $0.0176 would be ~28M SKR
    const big = fakeChain();
    const bigId = await makeWithdrawal("D2", 500_000_000_000);
    const q2 = await payout.quotePayout("commission", bigId, big);
    const r3 = await payout.payPayout({ acknowledgeRisk: true, kind: "commission", id: bigId, expectedSkrMicro: q2.skrMicro }, big);
    check("a payout over the single-payout limit is refused", !r3.ok && r3.code === "too_large" && big.state.sent.length === 0, r3.code);

    // daily cap: 100,000 SKR. Pretend 99,900 SKR already went out today.
    const capped = fakeChain();
    await q(`insert into commission_payouts (user_id, usd_micro, skr_micro, wallet, status, updated_at) values ('PAID', 1, 99900000000, $1, 'paid', now())`, [WALLET]);
    const capId = await makeClaim("D3");
    const r4 = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: capId }, capped);
    check("a payout that would push the last 24h past 100,000 SKR is refused", !r4.ok && r4.code === "daily_cap" && capped.state.sent.length === 0, r4.code);
    await q(`delete from commission_payouts where user_id = 'PAID'`);

    const badWallet = fakeChain();
    const bwId = await makeClaim("D4");
    await q(`update shar_claims set wallet = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' where id = $1`, [bwId]);
    const r5 = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: bwId }, badWallet);
    check("a payout to a program address is refused", !r5.ok && r5.code === "bad_wallet" && badWallet.state.sent.length === 0);

    const toSelf = fakeChain();
    const selfId = await makeClaim("D5");
    await q(`update shar_claims set wallet = $1 where id = $2`, [toSelf.treasuryAddress(), selfId]);
    const r6 = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: selfId }, toSelf);
    check("a payout to the treasury itself is refused", !r6.ok && toSelf.state.sent.length === 0, r6.code);
  }

  // ── 5. THE DOUBLE-PAYMENT CASES
  {
    // 5a. The broadcast call fails with an error AFTER the network actually received it (very common: a timeout).
    const chain = fakeChain();
    chain.state.sendMode = "throw_after_landing";
    const id = await makeClaim("E1");
    const r = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, chain);
    check("send errors after landing: reported as uncertain, NOT as failed", !r.ok && r.code === "send_uncertain", r.code);
    const stuck = await row("shar_claims", id);
    check("the payout stays 'sent' with its signature saved (never silently retried)", stuck.status === "sent" && !!stuck.tx_signature && Number(stuck.last_valid_block_height) === 1150);
    const blind = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, chain);
    check("an admin clicking Pay again on a 'sent' payout is refused: no second transaction", !blind.ok && blind.status === 409 && chain.state.sent.length === 1);
    const rec = await payout.reconcilePayout("shar_claim", id, chain);
    check("reconcile sees it landed and marks it PAID (one payment total)", rec.ok && rec.outcome === "paid" && (await row("shar_claims", id)).status === "paid" && chain.state.sent.length === 1, JSON.stringify(rec));
    check("reconciling a paid payout again changes nothing", (await payout.reconcilePayout("shar_claim", id, chain)).outcome === "unchanged");

    // 5b. The send fails and the transaction really never reached the network. Retry only after it has EXPIRED.
    const c2 = fakeChain();
    c2.state.sendMode = "throw_before_landing";
    const id2 = await makeClaim("E2");
    await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: id2 }, c2);
    const early = await payout.reconcilePayout("shar_claim", id2, c2);
    check("reconciling BEFORE the transaction expires does not release it (it could still land)", early.ok && early.outcome === "pending" && (await row("shar_claims", id2)).status === "sent");
    const stillBlocked = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: id2 }, c2);
    check("...and it can't be paid again meanwhile", !stillBlocked.ok && c2.state.sent.length === 1);
    c2.state.height += 200; // past the last valid block height
    const late = await payout.reconcilePayout("shar_claim", id2, c2);
    check("after expiry, with nothing on-chain, reconcile releases it back to the queue", late.ok && late.outcome === "released" && (await row("shar_claims", id2)).status === "requested", JSON.stringify(late));
    check("the old signature is cleared", (await row("shar_claims", id2)).tx_signature === null);
    c2.state.sendMode = "ok";
    const retry = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: id2 }, c2);
    check("the retry makes a NEW transaction and pays exactly once", retry.ok && c2.state.landed.size === 1 && c2.state.sent.length === 2, `landed=${c2.state.landed.size}`);

    // 5c. Broadcast "succeeds" but the transaction is dropped. Nothing landed; never marked paid.
    const c3 = fakeChain();
    c3.state.sendMode = "drop";
    c3.state.confirmMode = "timeout";
    const id3 = await makeClaim("E3");
    const r3 = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: id3 }, c3);
    check("a confirmation timeout leaves it 'sent', not 'paid'", r3.ok && r3.status === "sent" && (await row("shar_claims", id3)).status === "sent");
    c3.state.height += 200;
    const rec3 = await payout.reconcilePayout("shar_claim", id3, c3);
    check("a dropped transaction is released only after it expired", rec3.outcome === "released" && c3.state.landed.size === 0);

    // 5d. The transaction lands but FAILED on-chain: no money moved, safe to retry immediately.
    const c4 = fakeChain();
    c4.state.confirmMode = "failed";
    const id4 = await makeClaim("E4");
    const r4 = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: id4 }, c4);
    check("a transaction that fails on-chain goes straight back to the queue", !r4.ok && r4.code === "tx_failed" && (await row("shar_claims", id4)).status === "requested");

    // 5e. It landed just as it was about to be released (the last-look check).
    const c5 = fakeChain();
    c5.state.sendMode = "drop";
    const id5 = await makeClaim("E5");
    c5.state.confirmMode = "timeout";
    await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: id5 }, c5);
    const sig5 = (await row("shar_claims", id5)).tx_signature;
    c5.state.height += 200;
    let calls = 0;
    const origStatus = c5.status;
    c5.status = async (s) => (++calls === 1 ? null : { confirmed: true, err: null }); // first look: nothing; second look: it landed
    const rec5 = await payout.reconcilePayout("shar_claim", id5, c5);
    check("if it lands right at the end, reconcile marks it paid instead of releasing it", rec5.outcome === "paid", JSON.stringify(rec5));
    c5.status = origStatus;

    // 5f. A payout stuck in 'processing' (the server died before signing anything)
    const c6 = fakeChain();
    const id6 = await makeClaim("E6");
    await q(`update shar_claims set status = 'processing', updated_at = now() where id = $1`, [id6]);
    check("a fresh 'processing' payout is left alone", (await payout.reconcilePayout("shar_claim", id6, c6)).outcome === "pending");
    await q(`update shar_claims set updated_at = now() - interval '10 minutes' where id = $1`, [id6]);
    check("an old 'processing' payout (nothing was ever signed) is released", (await payout.reconcilePayout("shar_claim", id6, c6)).outcome === "released" && (await row("shar_claims", id6)).status === "requested");
  }

  // ── 6. While a claim is being paid, the Shar can't be spent again
  {
    const chain = fakeChain();
    chain.state.sendMode = "drop";
    chain.state.confirmMode = "timeout";
    const id = await makeClaim("F1", 3000); // 3,000 Shar; claims 1,000
    await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, chain);
    const s = await shar.getSummary("F1");
    check("a claim in flight still counts against the balance (2,000 left)", s.available === 2000 && s.claim.open && s.claim.open.sending === true, `${s.available}`);
    const second = await shar.createClaim("F1", { shar: 1000, wallet: WALLET });
    check("a second claim can't be made while one is being sent (409)", !second.ok && second.status === 409);
    check("the activity shows it as on its way", s.activity.find((a) => a.kind === "claim")?.state === "sending");
  }

  // ── 7. Rejecting
  {
    const id = await makeClaim("G1");
    check("rejecting a waiting claim works and the Shar returns", (await payout.rejectPayout("shar_claim", id, "wrong wallet")).ok && (await shar.getSummary("G1")).available === 2000);
    check("rejecting it again is refused", !(await payout.rejectPayout("shar_claim", id, "x")).ok);
    const wid = await makeWithdrawal("G2", 7_000_000);
    check("rejecting a withdrawal returns the money to the owner's balance", (await payout.rejectPayout("commission", wid, "nope")).ok && Number((await q(`select available_micro from earnings_balances where user_id = 'G2'`))[0].available_micro) === 7_000_000);
    check("...without inflating lifetime earnings", Number((await q(`select lifetime_micro from earnings_balances where user_id = 'G2'`))[0].lifetime_micro) === 7_000_000);
    const chain = fakeChain();
    const cid = await makeClaim("G3");
    await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: cid }, chain);
    check("a paid payout can't be rejected", !(await payout.rejectPayout("shar_claim", cid, "x")).ok);
    check("a rejected payout can't be paid", !(await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id }, chain)).ok);
  }

  // ── 8. The quote parser refuses junk
  {
    const p = payout.parseJupiterQuote;
    check("a real Jupiter quote shape parses", p({ outAmount: "1760000000", priceImpactPct: "0.0066" }).skrMicro === 1_760_000_000);
    for (const [label, bad] of [["no outAmount", {}], ["zero", { outAmount: "0" }], ["negative", { outAmount: "-5" }], ["decimal", { outAmount: "1.5" }], ["text", { outAmount: "lots" }], ["number not string", { outAmount: 5 }], ["huge impact", { outAmount: "100", priceImpactPct: "9" }], ["null", null], ["error body", { error: "boom" }]]) {
      let threw = false;
      try { p(bad); } catch { threw = true; }
      check(`the quote parser refuses: ${label}`, threw);
    }
  }

  // ── 9. Not configured
  {
    const r = await payout.payPayout({ acknowledgeRisk: true, kind: "shar_claim", id: "00000000-0000-0000-0000-000000000000" });
    check("with no treasury key configured, paying says so plainly (503)", !r.ok && r.status === 503 && r.code === "not_configured");
  }

  finish();
})().catch((e) => {
  console.error("TEST HARNESS ERROR", e);
  process.exit(1);
});
