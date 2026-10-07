/**
 * An owner's OWN terms for the people who use their provider: the rules, saving them with a listing, agreeing to them (recorded on the
 * server, to a specific version), the gate on calls (nothing is charged or sent until agreed), what changing them does (back to review,
 * everyone asked again), outside agents (x402) accepting by header, and a database without the new tables. The real src code on an
 * in-memory Postgres built from the real migrations.
 *
 *     node scripts/tests/provider-terms.test.cjs
 */
const { makeLoader, freshDb, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

const ADMIN = "did:privy:admin1";
const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
class Res { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = init.headers ?? {}; } static json(d, i) { return new Res(JSON.stringify(d), i); } }
const auth = { user: "OWNER", ok: true };

(async () => {
  const { client, db } = await freshDb();
  const load = makeLoader({
    "next/server": { NextResponse: Res, NextRequest: class {} },
    "@/lib/auth": { verifyAuth: async () => { if (!auth.ok) throw new Error("nope"); return { userId: auth.user }; }, getUserWalletAddresses: async () => ({ evm: [], solana: [] }) },
    "@/lib/auth-response": { authErrorResponse: () => Res.json({ error: "Unauthorized" }, { status: 401 }) },
    "@/lib/user-rate-limiter": { checkApiLimit: async () => ({ allowed: true, headers: {} }) },
    "@/lib/rate-limit-store": { hit: async () => ({ allowed: true }) },
    "@/lib/server-env": { getServerEnv: (n) => ({ NETWORK_ADMIN_USER_IDS: ADMIN })[n] },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
    "@/lib/db": { db },
  });
  const rules = load("src/lib/provider-terms-rules.ts");
  const net = load("src/lib/provider-network.ts");
  const admin = load("src/lib/admin.ts");
  const credits = load("src/lib/credits.ts");
  const pubRules = load("src/lib/provider-publisher-rules.ts");
  const submitRoute = load("src/app/api/network/providers/route.ts");
  const patchRoute = load("src/app/api/network/providers/[id]/route.ts");
  const callRoute = load("src/app/api/network/providers/[id]/call/route.ts");
  const termsRoute = load("src/app/api/network/providers/[id]/terms/route.ts");
  const x402Route = load("src/app/api/network/providers/[id]/x402/route.ts");
  const q = async (text, params = []) => (await client.query(text, params)).rows;

  // ── the rules ─────────────────────────────────────────────────────────────
  const nt = rules.normalizeCustomTerms;
  const GOOD = "You may use this service for lawful purposes only. No resale of the data.";
  check("none sent means none", nt(undefined).value === null && nt(null).value === null && nt({}).value === null && nt({ text: "", url: "" }).value === null && nt({ text: null, url: null }).value === null);
  check("text only, link only, or both", nt({ text: GOOD }).value.text === GOOD && nt({ text: GOOD }).value.url === null && nt({ url: "https://acme.example.com/terms" }).value.url === "https://acme.example.com/terms" && nt({ text: GOOD, url: "https://acme.example.com/terms" }).ok);
  check("line breaks are kept, surrounding space trimmed, Windows line endings tidied", nt({ text: "  " + GOOD + "\r\nSecond line is here.  " }).value.text === GOOD + "\nSecond line is here.");
  check("too short to mean anything is refused (but a link alone is fine)", nt({ text: "ok fine" }).ok === false && /too short/.test(nt({ text: "ok fine" }).error) && nt({ text: "   " }).value === null);
  check("up to 2,000 characters, no more", nt({ text: "x".repeat(2000) }).ok === true && nt({ text: "x".repeat(2001) }).ok === false && /link/.test(nt({ text: "x".repeat(2001) }).error));
  check("the link must be a public https address", ["http://a.example.com", "https://10.0.0.1", "javascript:1", "https://localhost", "acme.example.com"].every((u) => nt({ url: u }).ok === false));
  check("odd input is refused, not crashed on", nt("terms").ok === false && nt([GOOD]).ok === false && nt({ text: 5 }).ok === false && nt({ text: GOOD + "\u0000" }).ok === false);
  const h1 = rules.termsHash({ text: GOOD, url: null });
  check("the fingerprint is stable and changes with the text or the link", h1 === rules.termsHash({ text: GOOD, url: null }) && h1 !== rules.termsHash({ text: GOOD + " ", url: null }) && h1 !== rules.termsHash({ text: GOOD, url: "https://a.example.com/" }) && /^[0-9a-f]{16}$/.test(h1) && rules.termsHash({ text: null, url: "https://a.example.com/" }) !== rules.termsHash({ text: "https://a.example.com/", url: null }));
  check("an agent accepts only with the exact hash", rules.agentAccepts(h1, h1) && rules.agentAccepts("  " + h1 + " ", h1) && !rules.agentAccepts(null, h1) && !rules.agentAccepts("", h1) && !rules.agentAccepts(h1.toUpperCase(), h1) && !rules.agentAccepts("nope", h1));

  // ── saving terms with a listing ───────────────────────────────────────────
  const V = pubRules.PROVIDER_TERMS_VERSION;
  const body = (name, o = {}) => ({ name, summary: "A provider with its own terms for people.", category: "data", endpointUrl: "https://api.example.com/x", priceUsdc: "0", payoutWallet: WALLET, operatorType: "individual", contactEmail: "o@example.com", rightsConfirmed: true, termsAccepted: true, termsVersion: V, ...o });
  const call = async (handler, method, b, user = "OWNER", ctx, query = "", headers = {}) => {
    auth.user = user;
    const r = await handler[method]({ json: async () => b, nextUrl: new URL("https://x.test/api/network/providers" + query), text: async () => JSON.stringify(b ?? {}), headers: { get: (k) => headers[k.toLowerCase()] ?? null }, url: "https://x.test/api/network/providers/x/x402" }, ctx);
    return { status: r.status, body: JSON.parse(r.body), headers: r.headers };
  };
  const ctxOf = (id) => ({ params: Promise.resolve({ id }) });
  const enrolled = new Set();
  const post = async (b, user = "OWNER") => {
    if (!enrolled.has(user)) {
      const e = await net.enrollCreator(user, { operatorType: "individual", contactEmail: user.toLowerCase() + "@example.com", termsAccepted: true, termsVersion: V });
      if (!e.ok) throw new Error("enroll failed: " + e.error);
      enrolled.add(user);
    }
    return call(submitRoute, "POST", b, user);
  };
  const patch = (id, b, user = "OWNER") => call(patchRoute, "PATCH", b, user, ctxOf(id));
  const accept = (id, hash, user) => call(termsRoute, "POST", { hash }, user, ctxOf(id));
  const detail = async (id, user) => (await call(patchRoute, "GET", undefined, user, ctxOf(id))).body.provider;
  const status = async (id) => (await q(`select status from provider_listings where id = $1`, [id]))[0].status;
  const verify = (id) => net.reviewListing(id, "verify", null);

  const badTerms = await post(body("Bad Terms Wisp", { customTerms: { text: "nope" } }));
  check("submit: bad terms are refused (400) and nothing is stored", badTerms.status === 400 && /too short/.test(badTerms.body.error) && (await q(`select * from provider_listings`)).length === 0);
  const sub = await post(body("Termed Wisp", { customTerms: { text: GOOD, url: "https://acme.example.com/terms" } }));
  const id = sub.body.provider?.id;
  check("submit: a listing with its own terms is accepted and the terms are stored with their fingerprint", sub.status === 201 && (await q(`select * from provider_terms where listing_id = $1`, [id]))[0]?.terms_hash === rules.termsHash({ text: GOOD, url: "https://acme.example.com/terms" }));
  const plain = await post(body("Plain Wisp", { endpointUrl: "https://api.example.com/plain" }), "PLAIN");
  check("submit: a listing without terms stores none", plain.status === 201 && (await q(`select * from provider_terms where listing_id = $1`, [plain.body.provider.id])).length === 0);
  await verify(id);
  await verify(plain.body.provider.id);
  const hash = rules.termsHash({ text: GOOD, url: "https://acme.example.com/terms" });

  // ── what people see ───────────────────────────────────────────────────────
  const d1 = await detail(id, "ALICE");
  check("page: anyone sees the terms, their fingerprint, and that they haven't agreed yet", d1.terms && d1.terms.text === GOOD && d1.terms.url === "https://acme.example.com/terms" && d1.terms.hash === hash && d1.termsAcceptedAt === null);
  check("page: a provider with no terms shows none", (await detail(plain.body.provider.id, "ALICE")).terms === null);
  const list = (await call(submitRoute, "GET", undefined, "ALICE")).body.providers;
  check("browse: flags the providers that have terms", list.find((p) => p.id === id).hasOwnerTerms === true && list.find((p) => p.id === plain.body.provider.id).hasOwnerTerms === false);
  check("browse: the flag is all the list carries (the text isn't repeated for every provider)", !JSON.stringify(list).includes("lawful purposes"));
  const mine = (await call(submitRoute, "GET", undefined, "OWNER", undefined, "?mine=1")).body.providers.find((p) => p.id === id);
  check("owner: sees their own terms to edit them", mine.terms && mine.terms.text === GOOD);

  // ── the gate ──────────────────────────────────────────────────────────────
  const run = (listing, user, payload = {}) => net.runProviderCall(listing, user, payload, async () => ({ ok: true, status: 200, body: { fine: true } }));
  let listing = await net.getListing(id);
  const before = await run(listing, "ALICE");
  check("gate: someone who hasn't agreed is refused (409 terms_required) with a calm message, nothing sent", before.ok === false && before.status === 409 && before.code === "terms_required" && /agree/.test(before.error) && /weren.t charged/.test(before.error));
  check("gate: no usage was recorded", (await q(`select * from provider_usage where listing_id = $1`, [id])).length === 0);
  const owner = await run(listing, "OWNER");
  check("gate: the owner needs no agreement for their own provider", owner.ok === true);
  const viaRoute = await call(callRoute, "POST", {}, "ALICE", ctxOf(id));
  check("gate: the call route reports it too (409 with the code)", viaRoute.status === 409 && viaRoute.body.code === "terms_required");
  const noTerms = await run(await net.getListing(plain.body.provider.id), "ALICE");
  check("gate: a provider without terms is unaffected", noTerms.ok === true);

  // ── agreeing ──────────────────────────────────────────────────────────────
  check("agree: the wrong fingerprint is refused (409)", (await accept(id, "0000000000000000", "ALICE")).status === 409 && (await accept(id, undefined, "ALICE")).status === 409 && (await accept(id, 5, "ALICE")).status === 409);
  check("agree: signed out is refused", await (async () => { auth.ok = false; const r = await accept(id, hash, "ALICE"); auth.ok = true; return r.status === 401; })());
  check("agree: a bad id or an unknown provider is 404", (await call(termsRoute, "POST", { hash }, "ALICE", ctxOf("nope"))).status === 404 && (await accept("00000000-0000-0000-0000-000000000000", hash, "ALICE")).status === 404);
  check("agree: a provider with no terms has nothing to agree to (409)", (await accept(plain.body.provider.id, hash, "ALICE")).status === 409);
  const ok1 = await accept(id, hash, "ALICE");
  check("agree: the right fingerprint is recorded with the time", ok1.status === 200 && ok1.body.accepted === true && typeof ok1.body.acceptedAt === "string" && (await q(`select * from provider_terms_acceptances where listing_id = $1 and user_id = 'ALICE'`, [id])).length === 1);
  check("agree: doing it twice is harmless (still one record)", (await accept(id, hash, "ALICE")).status === 200 && (await q(`select * from provider_terms_acceptances where listing_id = $1 and user_id = 'ALICE'`, [id])).length === 1);
  check("agree: the page now shows when they agreed", (await detail(id, "ALICE")).termsAcceptedAt === ok1.body.acceptedAt);
  check("agree: it is per person (someone else still hasn't)", (await detail(id, "BOB")).termsAcceptedAt === null && (await run(listing, "BOB")).code === "terms_required");
  const after = await run(listing, "ALICE");
  check("gate: after agreeing the call goes through and is recorded", after.ok === true && (await q(`select * from provider_usage where listing_id = $1 and caller_user_id = 'ALICE'`, [id])).length === 1);

  // ── a PAID provider: refused before any charge ────────────────────────────
  const paidSub = await post(body("Paid Termed Wisp", { endpointUrl: "https://api.example.com/paid", priceUsdc: "0.50", customTerms: { text: GOOD } }), "PAYER-OWNER");
  const pid = paidSub.body.provider.id;
  await verify(pid);
  await credits.creditTopup("CAROL", "sig-carol", 5_000_000);
  const bal = async () => Number((await q(`select balance_micro from credit_balances where user_id = 'CAROL'`))[0].balance_micro);
  const paidListing = await net.getListing(pid);
  const refused = await run(paidListing, "CAROL");
  check("paid: refused BEFORE any charge (balance untouched, no ledger rows for a call)", refused.code === "terms_required" && (await bal()) === 5_000_000 && (await q(`select * from credit_ledger where user_id = 'CAROL' and kind = 'call'`)).length === 0);
  const ph = rules.termsHash({ text: GOOD, url: null });
  await accept(pid, ph, "CAROL");
  check("paid: after agreeing it is charged as normal", (await run(paidListing, "CAROL")).ok === true && (await bal()) === 4_500_000);

  // ── changing the terms ────────────────────────────────────────────────────
  const same = await patch(id, { customTerms: { text: GOOD, url: "https://acme.example.com/terms" } });
  check("edit: re-sending the same terms changes nothing (400 nothing to change)", same.status === 400 && /Nothing to change/.test(same.body.error));
  const NEW = "Updated terms: you must not store the answers for longer than 24 hours.";
  const e1 = await patch(id, { customTerms: { text: NEW, url: "https://acme.example.com/terms" } });
  check("edit: changing the terms sends a LIVE provider back for review", e1.status === 200 && e1.body.sentForReview === true && e1.body.wasLive === true && (await status(id)) === "submitted");
  await verify(id);
  listing = await net.getListing(id);
  const newHash = rules.termsHash({ text: NEW, url: "https://acme.example.com/terms" });
  check("edit: the fingerprint changed, so Alice's earlier agreement no longer counts", (await detail(id, "ALICE")).terms.hash === newHash && (await detail(id, "ALICE")).termsAcceptedAt === null && (await run(listing, "ALICE")).code === "terms_required");
  check("edit: the old fingerprint can't be agreed to any more (409)", (await accept(id, hash, "ALICE")).status === 409);
  await accept(id, newHash, "ALICE");
  check("edit: agreeing to the new version lets her back in", (await run(listing, "ALICE")).ok === true);
  check("edit: the old agreement is kept as a record (two versions on file)", (await q(`select terms_hash from provider_terms_acceptances where listing_id = $1 and user_id = 'ALICE' order by accepted_at`, [id])).length === 2);
  const bad = await patch(id, { customTerms: { text: "short" } });
  check("edit: bad terms are refused (400) and nothing changes", bad.status === 400 && (await status(id)) === "verified");
  const onlyContact = await patch(id, { teamNotes: "just a note" });
  check("edit: other free edits don't disturb the terms", onlyContact.status === 200 && onlyContact.body.sentForReview === false && (await detail(id, "ALICE")).termsAcceptedAt !== null);
  const rm = await patch(id, { customTerms: null });
  check("edit: removing the terms is also a reviewed change", rm.status === 200 && rm.body.sentForReview === true && (await q(`select * from provider_terms where listing_id = $1`, [id])).length === 0);
  await verify(id);
  listing = await net.getListing(id);
  check("edit: with no terms left, the gate opens for everyone again", (await run(listing, "BOB")).ok === true && (await detail(id, "BOB")).terms === null);
  const add = await patch(plain.body.provider.id, { customTerms: { text: GOOD } }, "PLAIN");
  check("edit: adding terms to a provider that had none also needs review", add.status === 200 && add.body.sentForReview === true && (await q(`select * from provider_terms where listing_id = $1`, [plain.body.provider.id])).length === 1);
  check("edit: someone else can't change a provider's terms (404)", (await patch(id, { customTerms: { text: GOOD } }, "STRANGER")).status === 404);

  // ── the team sees them ────────────────────────────────────────────────────
  auth.user = ADMIN;
  const queue = await admin.getQueue({ balances: async () => ({ skrMicro: 0, lamports: 0 }), treasuryAddress: () => "T" });
  const pl = queue.listings.find((l) => l.id === plain.body.provider.id);
  check("admin: the review queue shows the owner's terms so the team can check them against Bluvfi's rules", pl && pl.ownerTerms && pl.ownerTerms.text === GOOD && pl.ownerTerms.hash === rules.termsHash({ text: GOOD, url: null }));

  // ── outside agents (x402) ─────────────────────────────────────────────────
  const x = (headers) => call(x402Route, "POST", {}, "AGENT", ctxOf(pid), "", headers);
  const x1 = await x({});
  check("agent: with no acceptance it gets 428 with the terms and how to accept, and nothing is asked for or charged", x1.status === 428 && x1.body.error === "terms_required" && x1.body.terms.hash === ph && x1.body.terms.text === GOOD && x1.body.header === "x-bluvfi-terms" && /X-Bluvfi-Terms/.test(x1.body.message));
  const x2 = await x({ "x-bluvfi-terms": "0000000000000000" });
  check("agent: the wrong hash is the same 428", x2.status === 428);
  const x3 = await x({ "x-bluvfi-terms": ph });
  check("agent: with the right hash it moves on to payment (here 503: x402 isn't switched on in this test, which is AFTER the terms gate)", x3.status !== 428 && x3.status === 503 && /x402/i.test(x3.body.error));
  await verify(plain.body.provider.id); // the edit above sent it back to review; once live again its terms apply to agents too
  const x4 = await call(x402Route, "POST", {}, "AGENT", ctxOf(plain.body.provider.id), "", {});
  check("agent: a provider whose terms were just added needs the header too; a provider with none doesn't", x4.status === 428 && (await call(x402Route, "POST", {}, "AGENT", ctxOf(id), "", {})).status !== 428);

  // ── a database without the new tables ─────────────────────────────────────
  await client.exec(`drop table provider_terms_acceptances; drop table provider_terms;`);
  listing = await net.getListing(pid);
  const dz = await detail(pid, "ZED"); const rz = await run(await net.getListing(plain.body.provider.id), "ZED"); const rzPaid = await run(listing, "ZED"); const bz = await call(submitRoute, "GET", undefined, "ZED");
  check("not set up: no terms table means no terms: browsing, the page and calls all work as before", dz && dz.terms === null && rz.ok === true && rzPaid.code !== "terms_required" && bz.status === 200, JSON.stringify({ dz: dz && dz.terms, rz, rzPaid, bz: bz.status }).slice(0, 220));
  const early = await post(body("Early Terms Wisp", { endpointUrl: "https://api.example.com/early", customTerms: { text: GOOD } }), "EARLY");
  check("not set up: a submission WITH terms is refused calmly (503) and leaves nothing behind", early.status === 503 && (await q(`select * from provider_listings where owner_user_id = 'EARLY'`)).length === 0 && (await q(`select * from provider_publishers where owner_user_id = 'EARLY'`)).length === 0);
  const early2 = await post(body("Early Plain Wisp", { endpointUrl: "https://api.example.com/early2" }), "EARLY2");
  check("not set up: a submission WITHOUT terms still works", early2.status === 201);

  finish();
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
