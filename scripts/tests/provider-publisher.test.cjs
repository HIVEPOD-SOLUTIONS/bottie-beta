/**
 * Provider CREATORS: becoming one is an opt-in sign-up (who is behind it, how to reach them, agreement to the provider terms), and only
 * creators can add a provider. The pure rules, the sign-up/profile route, the gate on adding a provider, what the team sees in the
 * review queue, and what happens when a table isn't there yet. The real src code on an in-memory Postgres from the real migrations.
 *
 *     node scripts/tests/provider-publisher.test.cjs
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
    "@/lib/server-env": { getServerEnv: (n) => ({ NETWORK_ADMIN_USER_IDS: ADMIN }[n]) },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
    "@/lib/db": { db },
  });
  const rules = load("src/lib/provider-publisher-rules.ts");
  const net = load("src/lib/provider-network.ts");
  const admin = load("src/lib/admin.ts");
  const submit = load("src/app/api/network/providers/route.ts");
  const creatorRoute = load("src/app/api/creator/route.ts");
  const q = async (text, params = []) => (await client.query(text, params)).rows;

  const V = rules.PROVIDER_TERMS_VERSION;
  const signup = (o = {}) => ({ operatorType: "individual", contactEmail: "Ada@Example.com", termsAccepted: true, termsVersion: V, ...o });
  const v = (o) => rules.validateCreatorSignup(signup(o));

  // ── the rules ─────────────────────────────────────────────────────────────
  check("version: it is a date-style string the app can compare", /^\d{4}-\d{2}-\d{2}$/.test(V));
  check("individual: needs no company details; the email is lowercased", v().ok && v().value.operatorType === "individual" && v().value.companyName === null && v().value.contactEmail === "ada@example.com" && v().value.termsVersion === V);
  check("individual: a company name or website sent anyway is ignored", v({ companyName: "Acme", companyWebsite: "https://acme.example.com" }).value.companyName === null && v({ companyName: "Acme", companyWebsite: "https://acme.example.com" }).value.companyWebsite === null);
  check("company: the name is required (2–80 characters)", v({ operatorType: "company" }).ok === false && v({ operatorType: "company", companyName: "A" }).ok === false && v({ operatorType: "company", companyName: "x".repeat(81) }).ok === false && v({ operatorType: "company", companyName: "Ac" }).ok === true);
  check("company: the name is tidied, control characters refused", v({ operatorType: "company", companyName: "  Acme    Labs " }).value.companyName === "Acme Labs" && v({ operatorType: "company", companyName: "Ac\u0000me" }).ok === false);
  check("company: the website is optional but must be a public https address", v({ operatorType: "company", companyName: "Acme" }).value.companyWebsite === null && v({ operatorType: "company", companyName: "Acme", companyWebsite: "http://acme.example.com" }).ok === false && v({ operatorType: "company", companyName: "Acme", companyWebsite: "https://localhost" }).ok === false);
  check("operator: must be one of the two answers", v({ operatorType: undefined }).ok === false && v({ operatorType: "bot" }).ok === false && /individual or as a company/.test(v({ operatorType: "" }).error));
  check("email: required and must look like an address", ["", "ada", "ada@", "@example.com", "ada@example", "ada @example.com", "a@b.c"].every((e) => v({ contactEmail: e }).ok === false) && v({ contactEmail: "a@b.co" }).ok === true);
  check("email: too long or with control characters is refused", v({ contactEmail: "a".repeat(120) + "@example.com" }).ok === false && v({ contactEmail: "ada\u0000@example.com" }).ok === false);
  check("terms: must be an explicit true", [undefined, false, "true", 1, null].every((x) => v({ termsAccepted: x }).ok === false) && /terms/.test(v({ termsAccepted: false }).error));
  check("terms: an old or missing version is refused with a clear message", v({ termsVersion: "2020-01-01" }).ok === false && v({ termsVersion: undefined }).ok === false && /updated/.test(v({ termsVersion: "2020-01-01" }).error));
  check("a non-object is refused", [null, [], "x", 5].every((x) => rules.validateCreatorSignup(x).ok === false));
  check("rights: each listing needs an explicit true (not 'true', 1, or missing)", [undefined, false, "true", 1, null].every((x) => rules.validateRightsConfirmed({ rightsConfirmed: x }).ok === false) && rules.validateRightsConfirmed({ rightsConfirmed: true }).ok === true && /own this service/.test(rules.validateRightsConfirmed({}).error) && rules.validateRightsConfirmed(null).ok === false);
  const cur = { operatorType: "individual", companyName: null, companyWebsite: null, contactEmail: "ada@example.com" };
  const u = (b, c = cur) => rules.validateCreatorUpdate(b, c);
  check("update: nothing sent, or the same values, is 'none'", u({}).kind === "none" && u({ contactEmail: "ADA@example.com" }).kind === "none" && u(null).kind === "none");
  check("update: only what is sent changes; the rest stays", u({ contactEmail: "new@example.com" }).value.operatorType === "individual" && Object.keys(u({ contactEmail: "new@example.com" }).changed).join() === "contactEmail");
  check("update: a company needs a name; individual drops company details", u({ operatorType: "company" }).ok === false && u({ operatorType: "company", companyName: "Acme" }).value.companyName === "Acme" && u({ operatorType: "individual" }, { ...cur, operatorType: "company", companyName: "Acme" }).value.companyName === null);

  // ── the sign-up route ─────────────────────────────────────────────────────
  const call = async (handler, body, user = "OWNER") => {
    auth.user = user;
    const r = await handler({ json: async () => body });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  const get = (user = "OWNER") => call(() => creatorRoute.GET(), undefined, user);
  const enroll = (b, user = "OWNER") => call(creatorRoute.POST, b, user);
  const edit = (b, user = "OWNER") => call(creatorRoute.PATCH, b, user);
  const creators = async () => (await q(`select * from provider_creators`)).length;

  const g0 = await get();
  check("route: before signing up there is no creator profile, and the current terms version is given", g0.status === 200 && g0.body.creator === null && g0.body.termsVersion === V && g0.body.termsCurrent === false);
  const bad = await enroll(signup({ termsAccepted: false }));
  check("route: refusing the terms stops the sign-up (nothing stored)", bad.status === 400 && /terms/i.test(bad.body.error) && (await creators()) === 0);
  check("route: stale terms stop it", (await enroll(signup({ termsVersion: "2020-01-01" }))).status === 400 && (await creators()) === 0);
  check("route: an unreadable body is refused", (await call(creatorRoute.POST, undefined)).status === 400 || (await creators()) === 0);
  const s1 = await enroll(signup({ operatorType: "company", companyName: "Acme Labs", companyWebsite: "https://acme.example.com" }));
  const [row] = await q(`select * from provider_creators where user_id = 'OWNER'`);
  check("route: a complete sign-up is accepted and stored", s1.status === 200 && s1.body.creator.companyName === "Acme Labs" && s1.body.termsCurrent === true && row && row.operator_type === "company" && row.contact_email === "ada@example.com" && row.company_website === "https://acme.example.com/" && row.terms_version === V);
  check("route: the agreement time comes from the server's clock", row && Math.abs(new Date(row.terms_accepted_at).getTime() - Date.now()) < 5 * 60_000);
  const s2 = await enroll(signup({ operatorType: "company", companyName: "Acme Labs", contactEmail: "later@example.com" }));
  check("route: signing up again is fine (idempotent): details refreshed, still one profile", s2.status === 200 && (await creators()) === 1 && (await q(`select contact_email from provider_creators`))[0].contact_email === "later@example.com");
  const g1 = await get();
  check("route: GET now returns the profile", g1.body.creator && g1.body.creator.contactEmail === "later@example.com" && g1.body.termsCurrent === true);
  check("route: someone else's profile is not visible to others", (await get("OTHER")).body.creator === null);

  // ── adding a provider is for creators only ────────────────────────────────
  const listing = (o = {}) => ({ name: "Weather Wisp", summary: "Hyperlocal forecasts for travellers.", category: "data", endpointUrl: "https://api.example.com/weather", priceUsdc: "0", payoutWallet: WALLET, rightsConfirmed: true, ...o });
  const post = (b, user = "OWNER") => call(submit.POST, b, user);
  const listings = async () => (await q(`select * from provider_listings`)).length;

  const nope = await post(listing(), "NOBODY");
  check("gate: someone who hasn't signed up can't add a provider (403 creator_required), nothing stored", nope.status === 403 && nope.body.code === "creator_required" && /creator/i.test(nope.body.error) && (await listings()) === 0);
  check("gate: the creator-only answers in a listing body can't stand in for signing up", (await post({ ...listing(), operatorType: "individual", contactEmail: "x@example.com", termsAccepted: true, termsVersion: V }, "NOBODY")).status === 403 && (await creators()) === 1);
  const noRights = await post(listing({ rightsConfirmed: false }));
  check("gate: a creator must still confirm they own THIS service (400)", noRights.status === 400 && /own this service/.test(noRights.body.error) && (await listings()) === 0);
  const badListing = await post(listing({ name: "x" }));
  check("gate: the listing's own rules still apply", badListing.status === 400 && /Name/.test(badListing.body.error) && (await q(`select * from provider_publishers`)).length === 0);

  const ok = await post(listing());
  check("gate: a creator's complete submission is accepted (201) and starts as submitted", ok.status === 201 && ok.body.provider.status === "submitted", JSON.stringify(ok.body));
  const [pub] = await q(`select * from provider_publishers where listing_id = $1`, [ok.body.provider.id]);
  check("stored: the listing's record is copied from the creator's profile, with the rights confirmation", pub && pub.owner_user_id === "OWNER" && pub.operator_type === "company" && pub.company_name === "Acme Labs" && pub.contact_email === "later@example.com" && pub.rights_confirmed === true && pub.terms_version === V);
  const two = await post(listing({ name: "Second Wisp", endpointUrl: "https://api.example.com/two" }));
  check("a creator can add more than one provider without signing up again", two.status === 201 && (await listings()) === 2);

  // ── terms change → agree again ────────────────────────────────────────────
  await q(`update provider_creators set terms_version = '2020-01-01' where user_id = 'OWNER'`);
  const stale = await post(listing({ name: "Third Wisp", endpointUrl: "https://api.example.com/three" }));
  check("terms: after the terms change, adding a provider asks them to agree again (409 creator_terms_outdated)", stale.status === 409 && stale.body.code === "creator_terms_outdated" && (await listings()) === 2);
  const g2 = await get();
  check("terms: GET says the agreement is out of date", g2.body.creator && g2.body.termsCurrent === false);
  check("terms: their existing providers keep working (editing isn't blocked)", (await net.updateListing("OWNER", ok.body.provider.id, { name: "Weather Wisp 2" })).ok === true);
  await enroll(signup({ operatorType: "company", companyName: "Acme Labs", contactEmail: "later@example.com" }));
  check("terms: agreeing again unblocks adding a provider", (await post(listing({ name: "Third Wisp", endpointUrl: "https://api.example.com/three" }))).status === 201);

  // ── editing the profile ───────────────────────────────────────────────────
  check("profile: a non-creator can't edit (403 creator_required)", (await edit({ contactEmail: "z@example.com" }, "NOBODY")).status === 403);
  const e1 = await edit({ contactEmail: "fresh@example.com" });
  check("profile: the email changes and is carried to every listing's record", e1.status === 200 && (await q(`select distinct contact_email from provider_publishers where owner_user_id = 'OWNER'`)).map((r) => r.contact_email).join() === "fresh@example.com");
  check("profile: nothing to change / bad values are refused", (await edit({ contactEmail: "fresh@example.com" })).status === 400 && (await edit({ contactEmail: "nope" })).status === 400);
  check("profile: it doesn't touch other owners' records", (await q(`select * from provider_publishers where owner_user_id <> 'OWNER'`)).length === 0);

  // ── what stays private ────────────────────────────────────────────────────
  await net.reviewListing(ok.body.provider.id, "verify", null);
  auth.user = "SOMEONE";
  const browse = JSON.parse((await submit.GET({ nextUrl: new URL("https://x.test/api/network/providers"), json: async () => ({}) })).body);
  check("privacy: the public list never carries the email or terms", browse.providers.length === 1 && !/fresh@example|later@example|contactEmail|termsVersion|rightsConfirmed/.test(JSON.stringify(browse)));
  auth.user = "OWNER";
  const mine = JSON.parse((await submit.GET({ nextUrl: new URL("https://x.test/api/network/providers?mine=1"), json: async () => ({}) })).body);
  const mineOk = mine.providers.find((p) => p.id === ok.body.provider.id);
  check("the owner sees their OWN contact details, and only theirs", mineOk && mineOk.publisher && mineOk.publisher.contactEmail === "fresh@example.com" && mine.providers.every((p) => !p.publisher || p.publisher.contactEmail === "fresh@example.com"));

  // ── what the team sees ────────────────────────────────────────────────────
  const legacy = await net.createListing("OLD", { name: "Legacy Wisp", summary: "From before the questions.", category: "data", endpointUrl: "https://api.example.com/legacy", priceUsdc: "0", payoutWallet: WALLET });
  const queue = await admin.getQueue({ balances: async () => ({ skrMicro: 0, lamports: 0 }), treasuryAddress: () => "T" });
  const [two2] = queue.listings.filter((l) => l.id === two.body.provider.id);
  check("admin: a submitted listing carries who is behind it and the terms", two2 && two2.publisher && two2.publisher.operatorType === "company" && two2.publisher.contactEmail === "fresh@example.com" && two2.publisher.termsVersion === V && two2.publisher.rightsConfirmed === true && typeof two2.publisher.termsAcceptedAt === "string");
  const [legacyRow] = queue.listings.filter((l) => l.id === legacy.listing.id);
  check("admin: a listing from before the questions has publisher: null (not an error)", legacyRow && legacyRow.publisher === null);

  // ── when a table isn't there yet ──────────────────────────────────────────
  await q(`drop table provider_publishers`);
  const early = await post(listing({ name: "Early Wisp", endpointUrl: "https://api.example.com/early" }));
  check("not set up (publishers): a submission gets 'being set up' (503) and leaves no listing behind", early.status === 503 && /being set up/i.test(early.body.error) && (await q(`select * from provider_listings where name = 'Early Wisp'`)).length === 0, JSON.stringify(early.body));
  check("not set up (publishers): a profile edit still works", (await edit({ contactEmail: "again@example.com" })).status === 200);
  const queue2 = await admin.getQueue({ balances: async () => ({ skrMicro: 0, lamports: 0 }), treasuryAddress: () => "T" });
  check("not set up (publishers): the review queue still loads, with publisher: null", queue2.listings.length >= 2 && queue2.listings.every((l) => l.publisher === null));
  await q(`drop table provider_creators`);
  const early2 = await post(listing({ name: "Early Two", endpointUrl: "https://api.example.com/early2" }));
  check("not set up (creators): adding a provider says 'being set up' (503), not a crash", early2.status === 503 && /being set up/i.test(early2.body.error), JSON.stringify(early2.body));
  const sign2 = await enroll(signup(), "NEWBIE");
  const gEarly = await get("NEWBIE");
  check("not set up (creators): sign-up says 'being set up' (503); GET reports ready:false", sign2.status === 503 && /being set up/i.test(sign2.body.error) && gEarly.status === 200 && gEarly.body.creator === null && gEarly.body.ready === false);
  check("not set up (creators): browsing providers is unaffected", JSON.parse((await submit.GET({ nextUrl: new URL("https://x.test/api/network/providers"), json: async () => ({}) })).body).providers.length === 1);

  finish();
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
