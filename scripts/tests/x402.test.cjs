/**
 * x402 edge for outside agents: the pure rules, the verify -> provider -> settle flow with every failure, exactly-once money
 * bookkeeping, the facilitator's HTTP client against a local fake server, and the top-up/x402 signature claim. The real
 * src/lib code on an in-memory Postgres built from the real migrations; the facilitator and the provider are simulated.
 *
 *     node scripts/tests/x402.test.cjs
 */
const http = require("http");
const crypto = require("crypto");
const { makeLoader, freshDb, reporter, req } = require("./_harness.cjs");
const { check, finish } = reporter();

const bs58 = req("bs58");
const b58 = (bs58.default ?? bs58).encode;
const sig = () => b58(crypto.randomBytes(64)); // a valid-looking transaction signature
const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const FEE = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const PAY_TO = "BLuvF1DepositAddress11111111111111111111111";
const PAYER = "AgentWa11et1111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

(async () => {
  const { client, db } = await freshDb();
  const stubs = {
    "@/lib/db": { db },
    "@/lib/auth": { getUserWalletAddresses: async () => ({ evm: [], solana: [] }) },
    "@/lib/server-env": { getServerEnv: () => undefined },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
  };
  const load = makeLoader(stubs);
  const net = load("src/lib/provider-network.ts");
  const credits = load("src/lib/credits.ts");
  const rules = load("src/lib/x402-rules.ts");
  const edge = load("src/lib/x402-edge.ts");
  const topup = load("src/lib/topup.ts");
  const q = async (text, params = []) => (await client.query(text, params)).rows;

  const mk = async (owner, name, price) => {
    const r = await net.createListing(owner, { name, summary: "Does something useful for testing.", category: "data", endpointUrl: "https://api.example.com/v1", priceUsdc: price, payoutWallet: WALLET });
    if (!r.ok) throw new Error(r.error);
    await net.reviewListing(r.listing.id, "verify", null);
    return net.getListing(r.listing.id);
  };
  const paid = await mk("OWNER", "Paid Wisp", "0.05");
  const free = await mk("OWNER", "Free Wisp", "0");

  // ── the pure rules ─────────────────────────────────────────────────────────
  const env = (o) => (n) => o[n];
  const good = { X402_FACILITATOR_URL: "https://facilitator.example.com/", CREDITS_DEPOSIT_ADDRESS: PAY_TO };
  const cfg = rules.loadX402Config(env(good));
  check("config: a valid facilitator URL and pay-to address switch it on (trailing slash trimmed, mainnet by default)", cfg && cfg.facilitatorUrl === "https://facilitator.example.com" && cfg.payTo === PAY_TO && cfg.network === "mainnet");
  check("config: X402_PAY_TO wins over the credits address", rules.loadX402Config(env({ ...good, X402_PAY_TO: WALLET })).payTo === WALLET);
  check("config: devnet can be selected", rules.loadX402Config(env({ ...good, X402_NETWORK: "devnet" })).network === "devnet");
  check("config: no facilitator -> off", rules.loadX402Config(env({ CREDITS_DEPOSIT_ADDRESS: PAY_TO })) === null);
  check("config: plain http to a real host -> off", rules.loadX402Config(env({ ...good, X402_FACILITATOR_URL: "http://facilitator.example.com" })) === null);
  check("config: http is fine for localhost (tests)", rules.loadX402Config(env({ ...good, X402_FACILITATOR_URL: "http://127.0.0.1:9" })) !== null);
  check("config: no pay-to address -> off", rules.loadX402Config(env({ X402_FACILITATOR_URL: good.X402_FACILITATOR_URL })) === null);
  check("config: a malformed pay-to address -> off", rules.loadX402Config(env({ ...good, X402_PAY_TO: "not an address" })) === null);
  check("config: a malformed fee payer override -> off", rules.loadX402Config(env({ ...good, X402_FEE_PAYER: "nope" })) === null);

  const reqs = rules.buildRequirements(cfg, 50_000, FEE);
  check("requirements: exact scheme on mainnet USDC for the price, paid to Bluvfi, fee payer set",
    reqs.scheme === "exact" && reqs.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" && reqs.asset === USDC && reqs.amount === "50000" && reqs.payTo === PAY_TO && reqs.extra.feePayer === FEE && reqs.maxTimeoutSeconds === 60);
  const dev = rules.buildRequirements({ ...cfg, network: "devnet" }, 50_000, FEE);
  check("requirements: devnet uses the devnet network and USDC mint", dev.network.startsWith("solana:EtWTRAB") && dev.asset === "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

  const wrap = (accepted, tx = "AQABAgMEBQYH") => ({ x402Version: 2, accepted, payload: { transaction: tx } });
  const enc = rules.encodeHeader;
  check("decode: a well-formed header is accepted", rules.decodePaymentHeader(enc(wrap(reqs))).ok === true);
  check("decode: garbage is refused", rules.decodePaymentHeader("%%%not-base64-json").ok === false);
  check("decode: empty / missing is refused", rules.decodePaymentHeader("").ok === false && rules.decodePaymentHeader(null).ok === false);
  check("decode: x402 version 1 is refused", rules.decodePaymentHeader(enc({ ...wrap(reqs), x402Version: 1 })).error === "unsupported_x402_version");
  check("decode: a payload without a transaction is refused", rules.decodePaymentHeader(enc({ x402Version: 2, accepted: reqs, payload: {} })).ok === false);
  check("decode: an oversized transaction is refused", rules.decodePaymentHeader(enc(wrap(reqs, "A".repeat(5000)))).ok === false);
  check("decode: an oversized header is refused before parsing", rules.decodePaymentHeader("A".repeat(9000)).ok === false);
  const m = (o) => rules.requirementsMatch({ ...reqs, ...o }, reqs);
  check("match: identical requirements match", m({}) === true);
  check("match: a LOWER amount does not", m({ amount: "1" }) === false);
  check("match: a different pay-to does not", m({ payTo: WALLET }) === false);
  check("match: a different asset does not", m({ asset: "So11111111111111111111111111111111111111112" }) === false);
  check("match: a different network does not", m({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }) === false);
  check("match: a different fee payer does not", m({ extra: { feePayer: WALLET } }) === false);
  check("match: a numeric amount equal to ours still matches (JSON clients)", m({ amount: 50000 }) === true);
  check("hash: the same transaction hashes the same, different ones differ",
    rules.paymentHash(wrap(reqs, "tx1")) === rules.paymentHash(wrap(reqs, "tx1")) && rules.paymentHash(wrap(reqs, "tx1")) !== rules.paymentHash(wrap(reqs, "tx2")));

  // ── the flow, with a simulated facilitator and provider ────────────────────
  const fac = { log: [], verify: { kind: "valid", payer: PAYER }, settle: () => ({ kind: "ok", transaction: sig(), payer: PAYER }), fee: FEE };
  const facilitator = {
    feePayer: async () => fac.fee,
    verify: async (p, r) => { fac.log.push("verify"); return typeof fac.verify === "function" ? fac.verify(p, r) : fac.verify; },
    settle: async (p, r) => { fac.log.push("settle"); return typeof fac.settle === "function" ? fac.settle(p, r) : fac.settle; },
  };
  let providerCalls = 0;
  let providerImpl = async () => ({ ok: true, status: 200, body: { answer: 42 } });
  const callProvider = async (l, p) => { fac.log.push("provider"); providerCalls++; return providerImpl(l, p); };
  const deps = { config: cfg, facilitator, callProvider };
  const URL_ = "https://www.bluvfi.xyz/api/network/providers/x/x402";
  const call = (listing, header, d = deps) => edge.handleX402Call({ listing, url: URL_, paymentHeader: header, payload: { q: 1 } }, d);
  const header = (tx) => enc(wrap(reqs, tx));
  const reset = () => { fac.log.length = 0; fac.verify = { kind: "valid", payer: PAYER }; fac.settle = () => ({ kind: "ok", transaction: sig(), payer: PAYER }); fac.fee = FEE; providerImpl = async () => ({ ok: true, status: 200, body: { answer: 42 } }); providerCalls = 0; };
  const receipt = async (tx) => (await q(`select * from x402_receipts where payload_hash = $1`, [rules.paymentHash(wrap(reqs, tx))]))[0];
  const earned = async () => Number((await q(`select available_micro from earnings_balances where user_id = 'OWNER'`))[0]?.available_micro ?? 0);
  const usage = async () => q(`select * from provider_usage where paid_micro > 0`);
  const origError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

  // asking for payment
  let r = await call(paid, null);
  const required = JSON.parse(Buffer.from(r.headers["PAYMENT-REQUIRED"], "base64").toString());
  check("no payment -> 402 with a PAYMENT-REQUIRED header and the same body", r.status === 402 && required.x402Version === 2 && JSON.stringify(required) === JSON.stringify(r.body));
  check("the request names the price, the asset, Bluvfi's address and the fee payer",
    required.accepts[0].amount === "50000" && required.accepts[0].asset === USDC && required.accepts[0].payTo === PAY_TO && required.accepts[0].extra.feePayer === FEE && required.resource.url === URL_);
  check("asking costs nothing: no facilitator call, no provider call, no receipt", fac.log.length === 0 && providerCalls === 0 && (await q(`select 1 from x402_receipts`)).length === 0);

  check("switched off -> 503", (await call(paid, null, { ...deps, config: null })).status === 503);
  check("a free provider -> 400 (use the app)", (await call(free, null)).status === 400);
  fac.fee = null;
  check("facilitator unreachable while asking -> 502, never a request with a made-up fee payer", (await call(paid, null)).status === 502);
  reset();

  // the happy path
  let r1 = await call(paid, header("tx-happy"));
  const rc1 = await receipt("tx-happy");
  check("a valid payment -> 200 with the provider's answer", r1.status === 200 && r1.body.data.answer === 42 && r1.body.paidMicro === 50_000, JSON.stringify(r1.body).slice(0, 100));
  check("the order is verify -> provider -> settle (money moves only after the provider answered)", fac.log.join(",") === "verify,provider,settle", fac.log.join(","));
  const pr = JSON.parse(Buffer.from(r1.headers["PAYMENT-RESPONSE"], "base64").toString());
  check("PAYMENT-RESPONSE carries the settlement signature, network and payer", pr.success === true && pr.transaction === r1.body.signature && pr.payer === PAYER && pr.network === reqs.network);
  check("the receipt is settled with the signature", rc1.status === "settled" && rc1.signature === r1.body.signature && rc1.payer === PAYER && Number(rc1.amount_micro) === 50_000);
  const u1 = (await usage())[0];
  check("one usage row: caller x402:<wallet>, 0 Shar, 50,000 split 40,000 / 10,000, ref = the signature",
    (await usage()).length === 1 && u1.caller_user_id === `x402:${PAYER}` && Number(u1.shar) === 0 && Number(u1.paid_micro) === 50_000 && Number(u1.owner_micro) === 40_000 && Number(u1.platform_micro) === 10_000 && u1.settlement_ref === rc1.signature);
  check("the owner earned 80% = 40,000", (await earned()) === 40_000);
  check("the signature is claimed by x402", (await q(`select kind from signature_claims where signature = $1`, [rc1.signature]))[0]?.kind === "x402");

  // replay
  reset();
  let r2 = await call(paid, header("tx-happy"));
  check("the SAME payment again -> 409 already used", r2.status === 409 && r2.body.error === "payment_already_used");
  check("a replay calls nothing and earns nothing", fac.log.length === 0 && providerCalls === 0 && (await earned()) === 40_000 && (await usage()).length === 1);

  // tampering
  reset();
  const cheap = enc(wrap({ ...reqs, amount: "1" }, "tx-cheap"));
  let r3 = await call(paid, cheap);
  check("paying LESS than asked -> 402 mismatch", r3.status === 402 && r3.body.error === "payment_requirements_mismatch");
  const toMe = enc(wrap({ ...reqs, payTo: WALLET }, "tx-elsewhere"));
  check("paying to a different address -> 402 mismatch", (await call(paid, toMe)).body.error === "payment_requirements_mismatch");
  check("a mismatch reaches neither facilitator nor provider and leaves no receipt", fac.log.length === 0 && providerCalls === 0 && !(await receipt("tx-cheap")));
  check("a malformed header -> 402 invalid_payment_header", (await call(paid, "%%%")).body.error === "invalid_payment_header");

  // verify fails
  reset();
  fac.verify = { kind: "invalid", reason: "insufficient_funds" };
  let r4 = await call(paid, header("tx-broke"));
  check("an invalid payment (no funds) -> 402 with the reason", r4.status === 402 && r4.body.error === "insufficient_funds");
  check("the provider is NOT called for an invalid payment, and the receipt is failed", providerCalls === 0 && fac.log.join() === "verify" && (await receipt("tx-broke")).status === "failed");
  reset();
  fac.verify = { kind: "error" };
  let r5 = await call(paid, header("tx-down"));
  check("facilitator down at verify -> 502, charged:false, provider not called", r5.status === 502 && r5.body.charged === false && providerCalls === 0 && (await receipt("tx-down")).status === "failed");

  // provider fails: nothing settles, and the SAME payment can be presented again
  reset();
  providerImpl = async () => ({ ok: true, status: 500, body: { error: "boom" } });
  let r6 = await call(paid, header("tx-retry"));
  check("provider error -> 502, charged:false, and settle is never called", r6.status === 502 && r6.body.charged === false && !fac.log.includes("settle") && (await receipt("tx-retry")).status === "failed", fac.log.join());
  providerImpl = async () => ({ ok: false, status: 502, error: "The provider didn't answer in time." });
  check("provider unreachable -> 502, nothing settled", (await call(paid, header("tx-retry"))).status === 502 && !fac.log.includes("settle"));
  providerImpl = async () => { throw new Error("socket hang up"); };
  check("provider throws -> 502, nothing settled", (await call(paid, header("tx-retry"))).status === 502 && !fac.log.includes("settle"));
  providerImpl = async () => ({ ok: true, status: 200, body: { answer: 7 } });
  fac.log.length = 0;
  let r7 = await call(paid, header("tx-retry"));
  check("after a failure the same signed payment can be presented again, and then succeeds", r7.status === 200 && r7.body.data.answer === 7 && fac.log.join() === "verify,provider,settle");
  check("…and it was paid for exactly once (usage 2 rows in total, owner 80,000)", (await usage()).length === 2 && (await earned()) === 80_000);

  // settle fails explicitly
  reset();
  fac.settle = { kind: "failed", reason: "transaction_failed" };
  let r8 = await call(paid, header("tx-nosettle"));
  check("settlement failed -> 402 and the answer is WITHHELD", r8.status === 402 && (r8.body.data === undefined && !/"answer"\s*:\s*42/.test(JSON.stringify(r8.body))) && r8.body.error.startsWith("settlement_failed"));
  check("…no usage, no commission, receipt failed", (await usage()).length === 2 && (await earned()) === 80_000 && (await receipt("tx-nosettle")).status === "failed");

  // settle outcome unknown
  reset();
  errors.length = 0;
  fac.settle = { kind: "unknown" };
  let r9 = await call(paid, header("tx-unknown"));
  const rc9 = await receipt("tx-unknown");
  check("settle outcome unknown -> 504 payment_pending and the answer is WITHHELD", r9.status === 504 && r9.body.error === "payment_pending" && (r9.body.data === undefined && !/"answer"\s*:\s*42/.test(JSON.stringify(r9.body))));
  check("…the receipt stays in settling (never retried automatically) and is logged as STUCK", rc9.status === "settling" && errors.some((e) => e.includes("STUCK: settlement outcome unknown")));
  reset();
  let r10 = await call(paid, header("tx-unknown"));
  check("presenting it again -> 409 payment_in_progress, no second settle, no provider call", r10.status === 409 && r10.body.error === "payment_in_progress" && fac.log.length === 0 && providerCalls === 0);
  check("a fresh unknown receipt is not yet 'stuck' for the admin", (await edge.listStuckX402()).length === 0);
  await q(`update x402_receipts set updated_at = now() - interval '10 minutes' where id = $1`, [rc9.id]);
  const stuck = await edge.listStuckX402();
  check("after a few minutes it shows up for an admin with listing, payer and amount", stuck.length === 1 && stuck[0].listing === "Paid Wisp" && stuck[0].payer === PAYER && stuck[0].amountMicro === 50_000);

  // settled, but the bookkeeping couldn't be written (signature already claimed by a top-up)
  reset();
  errors.length = 0;
  const taken = sig();
  await credits.creditTopup("SOMEONE", taken, 1_000_000);
  fac.settle = () => ({ kind: "ok", transaction: taken, payer: PAYER });
  let r11 = await call(paid, header("tx-claimed"));
  check("settled but unrecordable -> the agent still gets what it paid for", r11.status === 200 && r11.body.data.answer === 42);
  check("…nothing is double counted: no usage row, no commission, receipt left in settling and logged", (await usage()).length === 2 && (await earned()) === 80_000 && (await receipt("tx-claimed")).status === "settling" && errors.some((e) => e.includes("STUCK: settled but not recorded")));

  // the same money can't be a top-up too
  const x402Sig = rc1.signature;
  const t = await credits.creditTopup("THIEF", x402Sig, 1_000_000);
  check("creditTopup refuses an x402 payment's signature (no credits appear)", t.credited === false && t.balanceMicro === 0 && (await q(`select 1 from credit_ledger where user_id = 'THIEF'`)).length === 0);
  const depositTx = (from) => ({
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      preTokenBalances: [{ mint: USDC, owner: from, uiTokenAmount: { amount: "1000000" } }, { mint: USDC, owner: PAY_TO, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ mint: USDC, owner: from, uiTokenAmount: { amount: "0" } }, { mint: USDC, owner: PAY_TO, uiTokenAmount: { amount: "1000000" } }],
    },
  });
  const tr = await topup.topupFromSignature("THIEF", x402Sig, { getTx: async () => depositTx("THIEF_WALLET"), getWallets: async () => ["THIEF_WALLET"], depositAddress: () => PAY_TO });
  check("the top-up endpoint explains it: 409 'used to pay for a provider call'", tr.ok === false && tr.status === 409 && /provider call/.test(tr.error), JSON.stringify(tr));
  check("a normal top-up still works after the change", (await topup.topupFromSignature("OK_USER", sig(), { getTx: async () => depositTx("OK_WALLET"), getWallets: async () => ["OK_WALLET"], depositAddress: () => PAY_TO })).ok === true);

  // two copies of the same payment at once: exactly one wins
  reset();
  const [a, b] = await Promise.all([call(paid, header("tx-twin")), call(paid, header("tx-twin"))]);
  const statuses = [a.status, b.status].sort();
  check("the same payment sent twice at once -> one 200 and one 409", statuses[0] === 200 && statuses[1] === 409, statuses.join());
  check("…the provider ran once and settle ran once", providerCalls === 1 && fac.log.filter((x) => x === "settle").length === 1);

  // process died mid-flight
  reset();
  const staleHash = rules.paymentHash(wrap(reqs, "tx-crashed"));
  await q(`insert into x402_receipts (listing_id, payload_hash, amount_micro, status, updated_at) values ($1, $2, 50000, 'calling', now() - interval '10 minutes')`, [paid.id, staleHash]);
  let r12 = await call(paid, header("tx-crashed"));
  check("a 'calling' receipt older than 2 minutes (the process died before settling) can be presented again", r12.status === 200);
  const freshHash = rules.paymentHash(wrap(reqs, "tx-inflight"));
  await q(`insert into x402_receipts (listing_id, payload_hash, amount_micro, status) values ($1, $2, 50000, 'calling')`, [paid.id, freshHash]);
  reset();
  let r13 = await call(paid, header("tx-inflight"));
  check("a fresh 'calling' receipt is someone else's request in flight -> 409", r13.status === 409 && fac.log.length === 0);
  const otherListing = await mk("OWNER2", "Other Wisp", "0.05");
  await q(`update x402_receipts set status = 'failed' where payload_hash = $1`, [freshHash]);
  let r14 = await call(otherListing, header("tx-inflight"));
  check("a payment first used on one provider can't be replayed against another", r14.status === 409 && fac.log.length === 0, JSON.stringify(r14.body));

  // the ledger adds up
  const totals = (await q(`select sum(paid_micro)::int p, sum(owner_micro)::int o, sum(platform_micro)::int f, count(*)::int n from provider_usage where paid_micro > 0`))[0];
  check("books balance: owner + platform = paid across every settled payment", totals.p === totals.o + totals.f && totals.n >= 4, JSON.stringify(totals));
  check("books balance: the owner's earnings equal the sum of owner shares", (await earned()) === Number((await q(`select sum(owner_micro) s from provider_usage where listing_id = $1`, [paid.id]))[0].s));
  check("no x402 call ever earned the owner Shar", Number((await q(`select coalesce(sum(shar),0) s from provider_usage where caller_user_id like 'x402:%'`))[0].s) === 0);
  console.error = origError;

  // ── the facilitator's HTTP client against a local fake server ──────────────
  const seen = [];
  let mode = "ok";
  const server = http.createServer((rq, rs) => {
    const parts = [];
    rq.on("data", (c) => parts.push(c));
    rq.on("end", () => {
      const body = Buffer.concat(parts).toString();
      seen.push({ method: rq.method, url: rq.url, body: body ? JSON.parse(body) : null });
      const send = (status, obj) => { rs.writeHead(status, { "Content-Type": "application/json" }); rs.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
      if (mode === "drop") return rq.socket.destroy();
      if (rq.url === "/supported") {
        if (mode === "badsupported") return send(200, { kinds: [{ scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", x402Version: 2, extra: { feePayer: "short" } }] });
        return send(200, { kinds: [{ x402Version: 1, scheme: "exact", network: "solana", extra: { feePayer: WALLET } }, { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: FEE } }, { x402Version: 2, scheme: "exact", network: "eip155:8453" }] });
      }
      if (rq.url === "/verify") {
        if (mode === "garbage") return send(500, "<html>bad gateway</html>");
        if (mode === "invalid") return send(200, { isValid: false, invalidReason: "invalid_exact_svm_payload_transaction_amount_mismatch" });
        return send(200, { isValid: true, payer: PAYER });
      }
      if (rq.url === "/settle") {
        if (mode === "garbage") return send(502, "<html>bad gateway</html>");
        if (mode === "settlefail") return send(200, { success: false, errorReason: "transaction_failed", transaction: "", network: "x" });
        if (mode === "badsig") return send(200, { success: true, transaction: "nope", payer: PAYER });
        return send(200, { success: true, transaction: "5".repeat(88), payer: PAYER, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
      }
      send(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const hcfg = rules.loadX402Config(env({ X402_FACILITATOR_URL: `http://127.0.0.1:${server.address().port}`, CREDITS_DEPOSIT_ADDRESS: PAY_TO }));
  const hf = edge.httpFacilitator(hcfg);
  const pay = wrap(reqs, "tx-http");

  check("http: the fee payer comes from the facilitator's /supported (the v2 entry for this network)", (await hf.feePayer(hcfg)) === FEE);
  const before = seen.length;
  await hf.feePayer(hcfg);
  check("http: the fee payer is cached", seen.length === before);
  check("http: X402_FEE_PAYER overrides it without asking", (await edge.httpFacilitator({ ...hcfg, feePayer: WALLET }).feePayer({ ...hcfg, feePayer: WALLET })) === WALLET);
  mode = "badsupported";
  const devCfg = { ...hcfg, network: "devnet" };
  check("http: a malformed fee payer from the facilitator is refused (null)", (await edge.httpFacilitator(devCfg).feePayer(devCfg)) === null);
  mode = "ok";
  check("http: a network the facilitator doesn't list gives null", (await edge.httpFacilitator(devCfg).feePayer(devCfg)) === null);

  let v = await hf.verify(pay, reqs);
  const vr = seen.find((s) => s.url === "/verify");
  check("http verify: valid -> payer", v.kind === "valid" && v.payer === PAYER);
  check("http verify: sends x402Version 2 with the payment and OUR requirements", vr.body.x402Version === 2 && vr.body.paymentPayload.payload.transaction === "tx-http" && vr.body.paymentRequirements.amount === "50000" && vr.body.paymentRequirements.payTo === PAY_TO);
  mode = "invalid";
  v = await hf.verify(pay, reqs);
  check("http verify: isValid false -> invalid with the reason", v.kind === "invalid" && v.reason.startsWith("invalid_exact_svm"));
  mode = "garbage";
  check("http verify: a gateway error page -> error", (await hf.verify(pay, reqs)).kind === "error");
  mode = "drop";
  check("http verify: a dropped connection -> error", (await hf.verify(pay, reqs)).kind === "error");

  mode = "ok";
  let s = await hf.settle(pay, reqs);
  check("http settle: success -> the transaction signature and payer", s.kind === "ok" && s.transaction === "5".repeat(88) && s.payer === PAYER);
  mode = "settlefail";
  check("http settle: success:false -> failed with the reason", (s = await hf.settle(pay, reqs)).kind === "failed" && s.reason === "transaction_failed");
  mode = "garbage";
  check("http settle: a gateway error page -> UNKNOWN (never assumed failed: the money may have moved)", (await hf.settle(pay, reqs)).kind === "unknown");
  mode = "badsig";
  check("http settle: success with a malformed signature -> UNKNOWN", (await hf.settle(pay, reqs)).kind === "unknown");
  mode = "drop";
  check("http settle: a dropped connection -> UNKNOWN", (await hf.settle(pay, reqs)).kind === "unknown");
  server.close();

  finish();
})().catch((e) => {
  process.stderr.write(`x402 TEST CRASHED ${(e && e.stack) || e}\n`);
  process.exit(2);
});
