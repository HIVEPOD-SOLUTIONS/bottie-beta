/**
 * Provider setup: request inputs, requirements and setup link, the owner's saved API key (encrypted), private notes for the team,
 * the team's "needs more info", editing contact details, and what the gateway does with all of it. The pure rules, the secret box,
 * the submit / edit / review flows, the gateway, and what is public versus private. The real src code on an in-memory Postgres
 * built from the real migrations.
 *
 *     node scripts/tests/provider-config.test.cjs
 */
const { makeLoader, freshDb, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

const ADMIN = "did:privy:admin1";
const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
class Res { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = init.headers ?? {}; } static json(d, i) { return new Res(JSON.stringify(d), i); } }
const auth = { user: "OWNER", ok: true };
const env = { NETWORK_ADMIN_USER_IDS: ADMIN, PROVIDER_SECRET_KEY: KEY };

(async () => {
  const { client, db } = await freshDb();
  const load = makeLoader({
    "next/server": { NextResponse: Res, NextRequest: class {} },
    "@/lib/auth": { verifyAuth: async () => { if (!auth.ok) throw new Error("nope"); return { userId: auth.user }; }, getUserWalletAddresses: async () => ({ evm: [], solana: [] }) },
    "@/lib/auth-response": { authErrorResponse: () => Res.json({ error: "Unauthorized" }, { status: 401 }) },
    "@/lib/user-rate-limiter": { checkApiLimit: async () => ({ allowed: true, headers: {} }) },
    "@/lib/server-env": { getServerEnv: (n) => env[n] },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
    "@/lib/db": { db },
  });
  const cfg = load("src/lib/provider-config-rules.ts");
  const box = load("src/lib/secret-box.ts");
  const pubRules = load("src/lib/provider-publisher-rules.ts");
  const net = load("src/lib/provider-network.ts");
  const creatorRoute = load("src/app/api/creator/route.ts");
  const admin = load("src/lib/admin.ts");
  const submitRoute = load("src/app/api/network/providers/route.ts");
  const patchRoute = load("src/app/api/network/providers/[id]/route.ts");
  const detailRoute = patchRoute;
  const reviewRoute = load("src/app/api/network/providers/[id]/review/route.ts");
  const q = async (text, params = []) => (await client.query(text, params)).rows;
  const V = pubRules.PROVIDER_TERMS_VERSION;

  // ── input fields ──────────────────────────────────────────────────────────
  const f = (o = {}) => ({ key: "city", label: "City", type: "text", required: true, ...o });
  const nf = (list) => cfg.normalizeInputFields(list);
  check("fields: none sent / empty list means free-form (null)", nf(undefined).value === null && nf(null).value === null && nf([]).value === null);
  check("fields: a valid list is normalised (tidy label, nulls for the optional parts)", JSON.stringify(nf([f({ label: "  City   name " })]).value) === JSON.stringify([{ key: "city", label: "City name", type: "text", required: true, help: null, placeholder: null, choices: null, default: null }]));
  check("fields: not a list is refused", nf("x").ok === false && nf({}).ok === false && nf([null]).ok === false && nf([[]]).ok === false);
  check("fields: the name must be a plain identifier", ["", "1abc", "a b", "a-b", "é", "a".repeat(33)].every((k) => nf([f({ key: k })]).ok === false) && nf([f({ key: "a_1" })]).ok === true);
  check("fields: names must be unique (even in a different case)", nf([f(), f({ label: "Again" })]).ok === false && nf([f({ key: "City" }), f({ key: "city" })]).ok === false);
  check("fields: a label and a known type are required", nf([f({ label: "" })]).ok === false && nf([f({ label: "x".repeat(41) })]).ok === false && nf([f({ type: "date" })]).ok === false && nf([f({ type: undefined })]).ok === false);
  check("fields: help and example text have limits", nf([f({ help: "x".repeat(121) })]).ok === false && nf([f({ placeholder: "x".repeat(61) })]).ok === false && nf([f({ help: "Name of the city", placeholder: "Lagos" })]).ok === true);
  check("fields: a choice needs 2–10 different options", nf([f({ type: "choice" })]).ok === false && nf([f({ type: "choice", choices: ["a"] })]).ok === false && nf([f({ type: "choice", choices: ["a", "A"] })]).ok === false && nf([f({ type: "choice", choices: Array.from({ length: 11 }, (_, i) => "o" + i) })]).ok === false && nf([f({ type: "choice", choices: ["metric", "imperial"] })]).ok === true);
  check("fields: starting values must match the type", nf([f({ default: "Lagos" })]).ok === true && nf([f({ default: 3 })]).ok === false && nf([f({ type: "number", default: 3 })]).ok === true && nf([f({ type: "number", default: "3" })]).ok === false && nf([f({ type: "boolean", default: true })]).ok === true && nf([f({ type: "choice", choices: ["a", "b"], default: "c" })]).ok === false && nf([f({ type: "choice", choices: ["a", "b"], default: "b" })]).ok === true);
  check("fields: at most 12", nf(Array.from({ length: 12 }, (_, i) => f({ key: "k" + i }))).ok === true && nf(Array.from({ length: 13 }, (_, i) => f({ key: "k" + i }))).ok === false);

  // ── checking a caller's request against the inputs ────────────────────────
  const fields = nf([
    f({ key: "city", label: "City" }),
    f({ key: "days", label: "Days", type: "number", required: false, default: 3 }),
    f({ key: "units", label: "Units", type: "choice", choices: ["metric", "imperial"], required: false }),
    f({ key: "alerts", label: "Alerts", type: "boolean", required: false }),
  ]).value;
  const vc = (body) => cfg.validateCallInput(fields, body);
  check("call: a complete request passes, and a missing optional input takes its starting value", JSON.stringify(vc({ city: "Lagos" }).payload) === '{"city":"Lagos","days":3}');
  check("call: a required input must be filled (missing, null or blank)", [{}, { city: null }, { city: "   " }].every((b) => /“City” is required/.test(vc(b).error)));
  check("call: types are enforced (text, number, yes/no)", /must be text/.test(vc({ city: 5 }).error) && /must be a number/.test(vc({ city: "a", days: "3" }).error) && /must be a number/.test(vc({ city: "a", days: Infinity }).error) && /yes or no/.test(vc({ city: "a", alerts: "yes" }).error));
  check("call: a choice must be one of the options (and says which)", /one of: metric, imperial/.test(vc({ city: "a", units: "parsec" }).error) && vc({ city: "a", units: "metric" }).ok);
  check("call: text can't be huge", /too long/.test(vc({ city: "x".repeat(501) }).error));
  check("call: extra properties are allowed (the raw JSON option)", vc({ city: "a", extra: { deep: [1] } }).payload.extra.deep[0] === 1);
  check("call: with inputs defined the request must be an object", cfg.validateCallInput(fields, [1]).ok === false && cfg.validateCallInput(fields, "x").ok === false && cfg.validateCallInput(fields, null).ok === false);
  check("call: with NO inputs defined anything passes through untouched (as before)", cfg.validateCallInput(null, [1, 2]).payload.length === 2 && cfg.validateCallInput([], "x").payload === "x" && cfg.validateCallInput(null, undefined).ok);
  check("call: an example request can be built from the inputs", JSON.stringify(cfg.exampleFromFields(fields)) === '{"city":"","days":3,"units":"metric","alerts":false}' && cfg.exampleFromFields(null) === null);

  // ── requirements, setup link, notes ───────────────────────────────────────
  const rq = cfg.normalizeRequirements;
  check("requirements: none means none; up to five short steps; tidy", rq(undefined).value === null && rq([]).value === null && rq(["", "  "]).value === null && JSON.stringify(rq(["  Create a free account at Acme "]).value) === '["Create a free account at Acme"]');
  check("requirements: too many, too short or too long are refused", rq(Array.from({ length: 6 }, () => "A real step to do")).ok === false && rq(["no"]).ok === false && rq(["x".repeat(141)]).ok === false && rq("x").ok === false);
  check("setup link: public https only (or nothing)", cfg.normalizeSetupUrl("").value === null && cfg.normalizeSetupUrl("https://acme.example.com/signup").value === "https://acme.example.com/signup" && ["http://acme.example.com", "https://10.0.0.1", "javascript:1", "https://localhost"].every((u) => cfg.normalizeSetupUrl(u).ok === false));
  const tn = cfg.normalizeTeamNotes;
  check("team notes: optional, keeps line breaks, capped at 500", tn("").value === null && tn(undefined).value === null && tn("Please allowlist\n1.2.3.4").value === "Please allowlist\n1.2.3.4" && tn("x".repeat(501)).ok === false && tn(5).ok === false && tn("a\u0000b").ok === false);

  // ── credentials settings ──────────────────────────────────────────────────
  const va = cfg.validateAuth;
  check("auth: no settings or 'none' means no key", va(undefined).value.type === "none" && va({ type: "none", secret: "x" }).value.secret === null);
  check("auth: a header key needs a header name and the key", va({ type: "header", header: "X-API-Key", secret: "k" }).ok && va({ type: "header", secret: "k" }).ok === false && va({ type: "header", header: "X-API-Key" }).ok === false);
  check("auth: a bearer token always uses Authorization and needs the token", va({ type: "bearer", secret: "t" }).value.header === "Authorization" && va({ type: "bearer" }).ok === false);
  check("auth: header names Bluvfi owns or that frame the request are refused", ["Host", "content-length", "Content-Type", "Accept", "User-Agent", "Cookie", "Connection", "Transfer-Encoding", "X-Bluvfi-Listing", "x-bluvfi-anything"].every((h) => va({ type: "header", header: h, secret: "k" }).ok === false) && va({ type: "header", header: "bad header", secret: "k" }).ok === false && va({ type: "header", header: "x".repeat(41), secret: "k" }).ok === false);
  check("auth: the key can't hold line breaks or be empty/huge", va({ type: "bearer", secret: "a\nb" }).ok === false && va({ type: "bearer", secret: "x".repeat(501) }).ok === false && va({ type: "bearer", secret: "   " }).ok === false);
  check("auth: when a key is already saved an edit may leave it out", va({ type: "header", header: "X-API-Key" }, true).ok && va({ type: "header", header: "X-API-Key" }, true).value.secret === null);
  check("auth: the header sent for each kind", JSON.stringify(cfg.authHeaderFor("bearer", "Authorization", "t")) === '{"name":"Authorization","value":"Bearer t"}' && JSON.stringify(cfg.authHeaderFor("header", "X-API-Key", "k")) === '{"name":"X-API-Key","value":"k"}' && cfg.authHeaderFor("none", null, "k") === null);

  // ── the secret box ────────────────────────────────────────────────────────
  check("secret box: switched on only when a valid 32-byte key is set", box.secretsEnabled() === true);
  const enc = box.encryptSecret("sk_live_abc", "L1");
  check("secret box: round-trips, and the stored text doesn't contain the secret", box.decryptSecret(enc, "L1") === "sk_live_abc" && !enc.includes("sk_live_abc") && /^v1\.[^.]+\.[^.]+\.[^.]+$/.test(enc));
  check("secret box: a fresh nonce each time (same secret, different text)", box.encryptSecret("sk_live_abc", "L1") !== enc);
  check("secret box: it won't decrypt for another listing, or if altered", box.decryptSecret(enc, "L2") === null && box.decryptSecret(enc.slice(0, -4) + "AAAA", "L1") === null && box.decryptSecret("garbage", "L1") === null && box.decryptSecret("v1...", "L1") === null);
  env.PROVIDER_SECRET_KEY = "tooshort";
  check("secret box: a bad key means OFF (no plaintext fallback)", box.secretsEnabled() === false && box.decryptSecret(enc, "L1") === null && (() => { try { box.encryptSecret("x", "L1"); return false; } catch { return true; } })());
  env.PROVIDER_SECRET_KEY = Buffer.from(KEY, "hex").toString("base64");
  check("secret box: base64 keys work too", box.secretsEnabled() === true && box.decryptSecret(enc, "L1") === "sk_live_abc");
  env.PROVIDER_SECRET_KEY = KEY;

  // ── submitting with setup ─────────────────────────────────────────────────
  const listing = (o = {}) => ({ name: "Weather Wisp", summary: "Hyperlocal forecasts for travellers.", category: "data", endpointUrl: "https://api.example.com/weather", priceUsdc: "0", payoutWallet: WALLET, ...o });
  const who = (o = {}) => ({ operatorType: "individual", contactEmail: "ada@example.com", rightsConfirmed: true, termsAccepted: true, termsVersion: V, ...o });
  const setup = (o = {}) => ({
    inputFields: [f(), f({ key: "days", label: "Days", type: "number", required: false, default: 3 })],
    requirements: ["Create a free account at Acme", "Keep your account email handy"],
    setupUrl: "https://acme.example.com/signup",
    teamNotes: "Please allowlist 203.0.113.7. Test key emailed.",
    auth: { type: "header", header: "X-API-Key", secret: "sk_live_SUPERSECRET" },
    ...o,
  });
  const call = async (handler, method, body, user = "OWNER", ctx, query = "") => {
    auth.user = user;
    const r = await handler[method]({ json: async () => body, nextUrl: new URL("https://x.test/api/network/providers" + query), text: async () => JSON.stringify(body ?? {}) }, ctx);
    return { status: r.status, body: JSON.parse(r.body) };
  };
  // Only creators can add a provider: every owner in these tests signs up first (once).
  const enrolled = new Set();
  const ensureCreator = async (user) => {
    if (enrolled.has(user)) return;
    const e = await net.enrollCreator(user, { operatorType: "individual", contactEmail: user.toLowerCase() + "@example.com", termsAccepted: true, termsVersion: V });
    if (!e.ok) throw new Error("enroll failed: " + e.error);
    enrolled.add(user);
  };
  const post = async (body, user = "OWNER") => {
    await ensureCreator(user);
    return call(submitRoute, "POST", body, user);
  };
  const ctxOf = (id) => ({ params: Promise.resolve({ id }) });
  const row = async (id) => (await q(`select * from provider_configs where listing_id = $1`, [id]))[0];

  const bad = await post({ ...listing(), ...who(), ...setup({ inputFields: [f({ key: "1bad" })] }) });
  check("submit: bad setup is refused (400) and nothing is stored", bad.status === 400 && /name must start with a letter/.test(bad.body.error) && (await q(`select * from provider_listings`)).length === 0);
  for (const [label, o] of [["requirements", { requirements: ["x"] }], ["setup link", { setupUrl: "http://nope.example.com" }], ["notes", { teamNotes: "x".repeat(501) }], ["connection", { auth: { type: "header", secret: "k" } }]]) {
    const r = await post({ ...listing(), ...who(), ...setup(o) });
    check(`submit: a bad ${label} is refused (400)`, r.status === 400 && (await q(`select * from provider_listings`)).length === 0, JSON.stringify(r.body));
  }

  const ok = await post({ ...listing(), ...who(), ...setup() });
  check("submit: a listing with full setup is accepted (201)", ok.status === 201, JSON.stringify(ok.body));
  const id = ok.body.provider.id;
  const stored = await row(id);
  check("stored: inputs, requirements, setup link and notes", stored && JSON.parse(stored.input_fields).length === 2 && JSON.parse(stored.requirements).length === 2 && stored.setup_url === "https://acme.example.com/signup" && /allowlist/.test(stored.team_notes) && stored.auth_type === "header" && stored.auth_header === "X-API-Key");
  check("stored: the key is ENCRYPTED (the database never holds it in the clear)", stored.auth_secret_enc && !stored.auth_secret_enc.includes("SUPERSECRET") && box.decryptSecret(stored.auth_secret_enc, id) === "sk_live_SUPERSECRET");
  check("stored: nowhere in the database is the plaintext key", !JSON.stringify(await q(`select * from provider_configs`)).includes("SUPERSECRET") && !JSON.stringify(await q(`select * from provider_listings`)).includes("SUPERSECRET") && !JSON.stringify(await q(`select * from provider_publishers`)).includes("SUPERSECRET"));

  const plain = await post({ ...listing({ name: "Plain Wisp", endpointUrl: "https://api.example.com/plain" }), ...who() }, "PLAIN");
  check("submit: a listing with NO setup still works, and stores no setup row", plain.status === 201 && (await row(plain.body.provider.id)) === undefined);

  env.PROVIDER_SECRET_KEY = "";
  const noKey = await post({ ...listing({ name: "NoKey Wisp", endpointUrl: "https://api.example.com/nokey" }), ...who(), ...setup() }, "NOKEY");
  check("submit: with the server key off, saving an API key is refused (503) and nothing is stored", noKey.status === 503 && /isn’t switched on/.test(noKey.body.error) && (await q(`select * from provider_listings where owner_user_id = 'NOKEY'`)).length === 0);
  const noKeyOk = await post({ ...listing({ name: "NoAuth Wisp", endpointUrl: "https://api.example.com/noauth" }), ...who(), ...setup({ auth: undefined }) }, "NOKEY");
  check("submit: ...but a listing that needs no key is fine without the server key", noKeyOk.status === 201);
  env.PROVIDER_SECRET_KEY = KEY;

  // ── public versus private ─────────────────────────────────────────────────
  await net.reviewListing(id, "verify", null);
  auth.user = "STRANGER";
  const pub = (await call(detailRoute, "GET", undefined, "STRANGER", ctxOf(id))).body.provider;
  check("public: anyone sees the inputs, requirements and setup link", pub.inputFields.length === 2 && pub.inputFields[0].key === "city" && pub.requirements[0] === "Create a free account at Acme" && pub.setupUrl === "https://acme.example.com/signup");
  const browse = (await call(submitRoute, "GET", undefined, "STRANGER")).body;
  check("public: the browse list carries them too", browse.providers.find((p) => p.id === id).inputFields.length === 2);
  const publicText = JSON.stringify(pub) + JSON.stringify(browse);
  check("private: other people never see the team notes, the key, its ciphertext, or the auth settings", !/SUPERSECRET|allowlist|X-API-Key|teamNotes|auth|v1\./.test(publicText), publicText.slice(0, 120));
  const mine = (await call(submitRoute, "GET", undefined, "OWNER", undefined, "?mine=1")).body.providers.find((p) => p.id === id);
  check("owner: sees their notes and what kind of key is saved, and whether one is", mine.teamNotes === "Please allowlist 203.0.113.7. Test key emailed." && mine.auth.type === "header" && mine.auth.header === "X-API-Key" && mine.auth.hasSecret === true);
  check("owner: even the owner never gets the key back (no plaintext, no ciphertext)", !/SUPERSECRET|v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\./.test(JSON.stringify(mine)));

  // ── the gateway ───────────────────────────────────────────────────────────
  const listingRow = await net.getListing(id);
  const sent = [];
  const transport = async (req) => { sent.push(req); return { status: 200, body: Buffer.from('{"ok":true}'), truncated: false }; };
  const r1 = await net.callProvider(listingRow, { city: "Lagos" }, transport);
  check("gateway: sends the owner's key in the header they chose", r1.ok && sent[0].headers["X-API-Key"] === "sk_live_SUPERSECRET");
  check("gateway: the key can't override headers Bluvfi sets itself", sent[0].headers["Content-Type"] === "application/json" && sent[0].headers["User-Agent"] === "Bluvfi-Provider-Gateway/1.0" && sent[0].headers["X-Bluvfi-Listing"] === id);
  await q(`update provider_configs set auth_type = 'bearer', auth_header = 'Authorization' where listing_id = $1`, [id]);
  await net.callProvider(listingRow, { city: "Lagos" }, transport);
  check("gateway: a bearer token goes in Authorization", sent[1].headers.Authorization === "Bearer sk_live_SUPERSECRET");
  await q(`update provider_configs set auth_secret_enc = $2 where listing_id = $1`, [id, box.encryptSecret("x", "SOME-OTHER-LISTING")]);
  const before = sent.length;
  const r2 = await net.callProvider(listingRow, { city: "Lagos" }, transport);
  check("gateway: a key that can't be read FAILS CLOSED (502, nothing sent)", r2.ok === false && r2.status === 502 && /isn't set up correctly/.test(r2.error) && sent.length === before);
  env.PROVIDER_SECRET_KEY = "";
  await q(`update provider_configs set auth_secret_enc = $2 where listing_id = $1`, [id, enc]);
  const r3 = await net.callProvider(listingRow, { city: "Lagos" }, transport);
  check("gateway: with the server key gone it refuses rather than sending without the key", r3.ok === false && sent.length === before);
  env.PROVIDER_SECRET_KEY = KEY;
  await q(`update provider_configs set auth_secret_enc = $2 where listing_id = $1`, [id, box.encryptSecret("sk_live_SUPERSECRET", id)]);
  await q(`update provider_configs set auth_type = 'header', auth_header = 'X-API-Key' where listing_id = $1`, [id]);
  const plainListing = await net.getListing(plain.body.provider.id);
  await net.callProvider(plainListing, {}, transport);
  check("gateway: a provider with no key set gets no extra header", !Object.keys(sent.at(-1).headers).some((h) => /api-key|authorization/i.test(h)));

  // input checks before charging
  const caller = "CALLER";
  const run = (l, payload, user = caller) => net.runProviderCall(l, user, payload, async (_l, p) => ({ ok: true, status: 200, body: { echoed: p } }));
  const noCity = await run(listingRow, { days: 2 });
  check("call: a request missing a required input is refused (400) with the reason", noCity.ok === false && noCity.status === 400 && /“City” is required/.test(noCity.error));
  const good = await run(listingRow, { city: "Lagos" });
  check("call: a good request goes through with the starting values filled in", good.ok === true && JSON.stringify(good.data.echoed) === '{"city":"Lagos","days":3}');
  // a PAID provider: a malformed request must not even touch the credits
  await q(`update provider_listings set price_usdc = '0.50' where id = $1`, [id]);
  await q(`insert into credit_balances (user_id, balance_micro) values ($1, 5000000) on conflict (user_id) do update set balance_micro = 5000000`, [caller]);
  const paidListing = await net.getListing(id);
  const badPaid = await run(paidListing, { city: 12 });
  const bal = async () => Number((await q(`select balance_micro from credit_balances where user_id = $1`, [caller]))[0].balance_micro);
  check("call (paid): a bad request is refused BEFORE any charge (balance untouched, no ledger rows)", badPaid.ok === false && badPaid.status === 400 && (await bal()) === 5_000_000 && (await q(`select * from credit_ledger where user_id = $1 and kind = 'call'`, [caller])).length === 0);
  const goodPaid = await run(paidListing, { city: "Lagos" });
  check("call (paid): a good request is charged as normal", goodPaid.ok === true && (await bal()) === 4_500_000);
  await q(`update provider_listings set price_usdc = '0' where id = $1`, [id]);

  // ── editing: free versus reviewed ─────────────────────────────────────────
  const patch = (body, user = "OWNER", pid = id) => call(patchRoute, "PATCH", body, user, ctxOf(pid));
  const status = async (pid = id) => (await q(`select status, review_note from provider_listings where id = $1`, [pid]))[0];
  check("precondition: live", (await status()).status === "verified");

  const e1 = await patch({ teamNotes: "Updated note for the team" });
  check("edit: changing only the team notes is free (stays live, no review)", e1.status === 200 && e1.body.sentForReview === false && (await status()).status === "verified" && (await row(id)).team_notes === "Updated note for the team");
  const e2 = await patch({ auth: { type: "bearer", secret: "new-token-123" } });
  const afterAuth = await row(id);
  check("edit: replacing the key is free, re-encrypted, and the type follows", e2.status === 200 && e2.body.sentForReview === false && afterAuth.auth_type === "bearer" && box.decryptSecret(afterAuth.auth_secret_enc, id) === "new-token-123" && !JSON.stringify(e2.body).includes("new-token"));
  const encBefore = afterAuth.auth_secret_enc;
  const e3 = await patch({ auth: { type: "header", header: "X-Token" } });
  const afterHeader = await row(id);
  check("edit: changing the header WITHOUT a new key keeps the saved key", e3.status === 200 && afterHeader.auth_type === "header" && afterHeader.auth_header === "X-Token" && afterHeader.auth_secret_enc === encBefore);
  const e4 = await patch({ auth: { type: "none" } });
  const afterNone = await row(id);
  check("edit: switching to 'none' clears the saved key", e4.status === 200 && afterNone.auth_type === "none" && afterNone.auth_secret_enc === null && afterNone.auth_header === null);
  const e5 = await patch({ auth: { type: "bearer" } });
  check("edit: turning a key back on needs the key again", e5.status === 400 && /Enter the key/.test(e5.body.error));
  env.PROVIDER_SECRET_KEY = "";
  const e6 = await patch({ auth: { type: "bearer", secret: "t" } });
  check("edit: with the server key off, saving a key is refused (503)", e6.status === 503);
  env.PROVIDER_SECRET_KEY = KEY;
  const e7 = await patch({ auth: { type: "none" } });
  check("edit: re-sending an unchanged setting changes nothing (400 nothing to change)", e7.status === 400 && /Nothing to change/.test(e7.body.error));

  const e8 = await patch({ requirements: ["Create a free account at Acme", "A brand new step to do"] });
  const st8 = await status();
  check("edit: changing the requirements sends a LIVE listing back for review", e8.status === 200 && e8.body.sentForReview === true && e8.body.wasLive === true && st8.status === "submitted");
  await net.reviewListing(id, "verify", null);
  const e9 = await patch({ inputFields: [f({ key: "town", label: "Town" })] });
  check("edit: changing the inputs sends it back for review too", e9.status === 200 && e9.body.sentForReview === true && (await status()).status === "submitted");
  await net.reviewListing(id, "verify", null);
  const e10 = await patch({ setupUrl: "https://acme.example.com/other" });
  check("edit: changing the setup link sends it back for review", e10.body.sentForReview === true);
  await net.reviewListing(id, "verify", null);
  const e11 = await patch({ requirements: ["A brand new step to do", "Create a free account at Acme"] });
  check("edit: a different ORDER of requirements counts as a change (the checklist is what people see)", e11.body.sentForReview === true);
  await net.reviewListing(id, "verify", null);
  const e12 = await patch({ inputFields: [], requirements: [], setupUrl: "" });
  const cleared = await row(id);
  check("edit: clearing inputs, requirements and the link works", e12.status === 200 && cleared.input_fields === null && cleared.requirements === null && cleared.setup_url === null);
  await net.reviewListing(id, "verify", null);
  const e13 = await patch({ inputFields: "nope" });
  check("edit: a bad value is refused and changes nothing", e13.status === 400 && /list/.test(e13.body.error) && (await status()).status === "verified");
  const e14 = await patch({ name: "Weather Wisp Pro", teamNotes: "both at once" });
  check("edit: a listing field and a setup field together work in one save", e14.status === 200 && e14.body.sentForReview === true && (await row(id)).team_notes === "both at once" && (await q(`select name from provider_listings where id = $1`, [id]))[0].name === "Weather Wisp Pro");
  const e15 = await patch({ teamNotes: "x" }, "STRANGER");
  check("edit: someone else's listing is a 404", e15.status === 404);

  // ── the creator profile: who they are and how to reach them (free to change, no review)
  await net.reviewListing(id, "verify", null);
  const pubRow = async (pid = id) => (await q(`select * from provider_publishers where listing_id = $1`, [pid]))[0];
  const profile = async (user = "OWNER") => (await q(`select * from provider_creators where user_id = $1`, [user]))[0];
  const creatorPatch = (b, user = "OWNER") => call(creatorRoute, "PATCH", b, user);
  const c1 = await creatorPatch({ contactEmail: "NEW@Example.com" });
  check("profile: the email can be changed, lowercased, WITHOUT sending any listing back for review", c1.status === 200 && c1.body.creator.contactEmail === "new@example.com" && (await status()).status === "verified" && (await profile()).contact_email === "new@example.com");
  check("profile: their listings' records are kept in step (the team reads those)", (await pubRow()).contact_email === "new@example.com");
  check("profile: the agreement to the provider terms is untouched by a contact edit", (await profile()).terms_version === V && (await pubRow()).terms_version === V && (await pubRow()).rights_confirmed === true);
  const c2 = await creatorPatch({ operatorType: "company", companyName: "Acme Labs", companyWebsite: "https://acme.example.com" });
  check("profile: switching to a company needs a name; with one it works", (await creatorPatch({ operatorType: "company" })).status === 400 && c2.status === 200 && (await profile()).operator_type === "company" && (await pubRow()).company_name === "Acme Labs");
  const c3 = await creatorPatch({ operatorType: "individual" });
  check("profile: switching back to an individual drops the company details everywhere", c3.status === 200 && (await profile()).company_name === null && (await pubRow()).company_name === null && (await pubRow()).company_website === null);
  check("profile: a bad email or website is refused", (await creatorPatch({ contactEmail: "nope" })).status === 400 && (await creatorPatch({ operatorType: "company", companyName: "Acme", companyWebsite: "http://x.example.com" })).status === 400);
  check("profile: an unchanged value is 'nothing to change'", (await creatorPatch({ contactEmail: "new@example.com" })).status === 400);
  const mine2 = (await call(submitRoute, "GET", undefined, "OWNER", undefined, "?mine=1")).body.providers.find((p) => p.id === id);
  check("profile: the owner's list shows the new details", mine2.publisher.contactEmail === "new@example.com" && mine2.publisher.operatorType === "individual");
  check("profile: someone who isn't a creator can't edit one (403)", (await creatorPatch({ contactEmail: "x@example.com" }, "NOT-A-CREATOR")).status === 403 && (await creatorPatch({ contactEmail: "x@example.com" }, "NOT-A-CREATOR")).body.code === "creator_required");
  check("profile: a listing's own PATCH no longer takes contact details (they live on the profile)", (await patch({ contactEmail: "z@example.com" })).status === 400 && (await profile()).contact_email === "new@example.com");
  // a listing from before the questions: no publisher record, still managed as before
  const legacy = await net.createListing("OLD", listing({ name: "Legacy Wisp", endpointUrl: "https://api.example.com/legacy" }));
  // ── the team: what they see, and asking for more information ──────────────
  const sub = await post({ ...listing({ name: "Queue Wisp", endpointUrl: "https://api.example.com/queue" }), ...who({ contactEmail: "q@example.com" }), ...setup() }, "QUEUER");
  const qid = sub.body.provider.id;
  auth.user = ADMIN;
  const queue = await admin.getQueue({ balances: async () => ({ skrMicro: 0, lamports: 0 }), treasuryAddress: () => "T" });
  const entry = queue.listings.find((l) => l.id === qid);
  check("admin: the queue shows the setup, the notes for the team and what kind of key is saved", entry && entry.config.teamNotes.includes("allowlist") && entry.config.inputFields.length === 2 && entry.config.requirements.length === 2 && entry.config.setupUrl && entry.config.auth.type === "header" && entry.config.auth.hasSecret === true);
  check("admin: ...but never the key (or its ciphertext)", !/SUPERSECRET|v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\./.test(JSON.stringify(queue)));
  check("admin: a listing without setup shows an empty one (not an error)", queue.listings.find((l) => l.id === legacy.listing.id).config.inputFields === null);

  const review = (lid, body, user = ADMIN) => call(reviewRoute, "POST", body, user, ctxOf(lid));
  check("request info: only the team can", (await review(qid, { action: "request_info", note: "Which regions?" }, "OWNER")).status === 403);
  check("request info: needs a question", (await review(qid, { action: "request_info" })).status === 400 && (await review(qid, { action: "request_info", note: "   " })).status === 400);
  const ri = await review(qid, { action: "request_info", note: "Which regions do you serve?" });
  const afterRi = await status(qid);
  check("request info: the listing stays in the queue (submitted) with the question on it", ri.status === 200 && afterRi.status === "submitted" && afterRi.review_note === "Which regions do you serve?");
  const mineQ = (await call(submitRoute, "GET", undefined, "QUEUER", undefined, "?mine=1")).body.providers.find((p) => p.id === qid);
  check("request info: the owner sees the question on their listing", mineQ.status === "submitted" && mineQ.reviewNote === "Which regions do you serve?");
  const queue2 = await admin.getQueue({ balances: async () => ({ skrMicro: 0, lamports: 0 }), treasuryAddress: () => "T" });
  check("request info: the queue shows the question that is waiting for an answer", queue2.listings.find((l) => l.id === qid).reviewNote === "Which regions do you serve?");
  const reply = await patch({ teamNotes: "We serve West Africa." }, "QUEUER", qid);
  check("request info: the owner can answer in their notes for the team (free, stays in the queue)", reply.status === 200 && (await status(qid)).status === "submitted" && (await row(qid)).team_notes === "We serve West Africa.");
  await review(qid, { action: "verify" });
  check("request info: approving clears the question", (await status(qid)).status === "verified" && (await status(qid)).review_note === null);
  const riLive = await review(qid, { action: "request_info", note: "More?" });
  check("request info: only for a listing waiting for review (409 once live)", riLive.status === 409);
  check("request info: an unknown listing is 404", (await review("00000000-0000-0000-0000-000000000000", { action: "request_info", note: "x" })).status === 404);

  // ── "use the same key as my other provider" ───────────────────────────────
  const srcRes = await post({ ...listing({ name: "Source Wisp", endpointUrl: "https://api.example.com/src" }), ...who(), ...setup({ auth: { type: "header", header: "X-API-Key", secret: "sk_copy_ME_123" } }) }, "COPIER");
  const srcId = srcRes.body.provider.id;
  const cp = await post({ ...listing({ name: "Copy Wisp", endpointUrl: "https://api.example.com/copy" }), ...who(), ...setup({ auth: { type: "header", header: "X-API-Key", copySecretFrom: srcId } }) }, "COPIER");
  const cpId = cp.body.provider?.id;
  const srcEnc = (await row(srcId)).auth_secret_enc;
  const cpRow = cpId ? await row(cpId) : null;
  check("copy key: submitting with 'same key as my other provider' works", cp.status === 201 && cpRow && cpRow.auth_type === "header");
  check("copy key: the new provider holds the SAME key, re-encrypted for itself (different text, bound to its own id)", cpRow && box.decryptSecret(cpRow.auth_secret_enc, cpId) === "sk_copy_ME_123" && cpRow.auth_secret_enc !== srcEnc && box.decryptSecret(cpRow.auth_secret_enc, srcId) === null);
  check("copy key: the key appears in no response", !JSON.stringify(cp.body).includes("sk_copy_ME") && !JSON.stringify((await call(submitRoute, "GET", undefined, "COPIER", undefined, "?mine=1")).body).includes("sk_copy_ME"));
  const sentCopy = [];
  await net.callProvider(await net.getListing(cpId), { city: "Lagos" }, async (r) => { sentCopy.push(r); return { status: 200, body: Buffer.from("{}"), truncated: false }; });
  check("copy key: the gateway sends the copied key", sentCopy[0] && sentCopy[0].headers["X-API-Key"] === "sk_copy_ME_123");

  const stolen = await post({ ...listing({ name: "Thief Wisp", endpointUrl: "https://api.example.com/thief" }), ...who(), ...setup({ auth: { type: "header", header: "X-API-Key", copySecretFrom: srcId } }) }, "STRANGER2");
  check("copy key: someone else's provider can't be copied from (404, nothing stored), so keys can't be taken", stolen.status === 404 && (await q(`select * from provider_listings where owner_user_id = 'STRANGER2'`)).length === 0);
  const stolenEdit = await patch({ auth: { type: "bearer", copySecretFrom: srcId } }, "OWNER", id);
  check("copy key: ...nor on an edit", stolenEdit.status === 404);
  const noKeySrc = await post({ ...listing({ name: "Keyless Wisp", endpointUrl: "https://api.example.com/keyless" }), ...who(), ...setup({ auth: undefined }) }, "COPIER");
  const fromKeyless = await post({ ...listing({ name: "Wants Key Wisp", endpointUrl: "https://api.example.com/wantskey" }), ...who(), ...setup({ auth: { type: "bearer", copySecretFrom: noKeySrc.body.provider.id } }) }, "COPIER");
  check("copy key: a provider with no key saved can't be copied from (409, with a clear message)", fromKeyless.status === 409 && /no key saved/.test(fromKeyless.body.error));
  const badId = await post({ ...listing({ name: "Bad Id Wisp", endpointUrl: "https://api.example.com/badid" }), ...who(), ...setup({ auth: { type: "bearer", copySecretFrom: "not-a-uuid" } }) }, "COPIER");
  check("copy key: a bad id is refused (400)", badId.status === 400);
  const typed = await post({ ...listing({ name: "Typed Wisp", endpointUrl: "https://api.example.com/typed" }), ...who(), ...setup({ auth: { type: "bearer", secret: "typed-wins", copySecretFrom: srcId } }) }, "COPIER");
  check("copy key: a key typed in the same request wins", typed.status === 201 && box.decryptSecret((await row(typed.body.provider.id)).auth_secret_enc, typed.body.provider.id) === "typed-wins");
  const editCopy = await patch({ auth: { type: "bearer", copySecretFrom: srcId } }, "COPIER", cpId);
  const cpAfter = await row(cpId);
  check("copy key: on an edit it replaces the key, switches the type, and is free (no review)", editCopy.status === 200 && editCopy.body.sentForReview === false && cpAfter.auth_type === "bearer" && box.decryptSecret(cpAfter.auth_secret_enc, cpId) === "sk_copy_ME_123");
  env.PROVIDER_SECRET_KEY = "";
  const copyOff = await post({ ...listing({ name: "NoServerKey Wisp", endpointUrl: "https://api.example.com/nsk" }), ...who(), ...setup({ auth: { type: "bearer", copySecretFrom: srcId } }) }, "COPIER");
  check("copy key: with the server key off it can't copy (409: the stored key can't be read)", copyOff.status === 409);
  env.PROVIDER_SECRET_KEY = KEY;

  // ── when the setup table isn't there yet ──────────────────────────────────
  await q(`drop table provider_configs`);
  const reads = await call(submitRoute, "GET", undefined, "STRANGER");
  check("not set up: browsing still works, with empty setup", reads.status === 200 && reads.body.providers.length >= 1 && reads.body.providers.every((p) => p.inputFields === null && p.requirements === null));
  const callNoTable = await net.runProviderCall(await net.getListing(plain.body.provider.id), "CALLER2", { any: 1 }, async () => ({ ok: true, status: 200, body: { fine: true } }));
  check("not set up: calling a provider still works (no inputs to check)", callNoTable.ok === true);
  const early = await post({ ...listing({ name: "Early Wisp", endpointUrl: "https://api.example.com/early" }), ...who(), ...setup() }, "EARLY");
  check("not set up: a submission with setup gets 503 and leaves nothing behind", early.status === 503 && (await q(`select * from provider_listings where owner_user_id = 'EARLY'`)).length === 0 && (await q(`select * from provider_publishers where owner_user_id = 'EARLY'`)).length === 0);
  const noSetupEarly = await post({ ...listing({ name: "Early2 Wisp", endpointUrl: "https://api.example.com/early2" }), ...who() }, "EARLY2");
  check("not set up: a submission WITHOUT setup still works", noSetupEarly.status === 201);

  finish();
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
