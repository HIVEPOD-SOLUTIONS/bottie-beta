/**
 * Listing management: example requests, owner edit / pause / resume / remove, the team's featured flag, search, filters, sorting
 * and the provider detail page. The real src/lib code on an in-memory Postgres built from the real migrations.
 *
 *     node scripts/tests/listing-management.test.cjs
 */
const { makeLoader, freshDb, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";
const WALLET2 = "DKL92bJrYVWKLsmmw8NDGjSsEc5Xc8LzJbP1JEnDVSoF".slice(0, 44);

(async () => {
  const { client, db } = await freshDb();
  const load = makeLoader({
    "@/lib/db": { db },
    "@/lib/server-env": { getServerEnv: () => undefined },
    "node:dns": { promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } },
  });
  const rules = load("src/lib/provider-network-rules.ts");
  const net = load("src/lib/provider-network.ts");
  const q = async (text, params = []) => (await client.query(text, params)).rows;
  const row = async (id) => (await q(`select * from provider_listings where id = $1`, [id]))[0];

  // ── example request ───────────────────────────────────────────────────────
  const ex = rules.normalizeExampleRequest;
  check("example: empty / missing -> null", ex(undefined).value === null && ex("").value === null && ex("   ").value === null && ex(null).value === null);
  check("example: JSON text is stored compact", ex('{ "city" : "Lagos" }').value === '{"city":"Lagos"}');
  check("example: an object is accepted and serialised", ex({ city: "Lagos", days: 3 }).value === '{"city":"Lagos","days":3}');
  check("example: invalid JSON is refused", ex("{city: Lagos}").ok === false && /valid JSON/.test(ex("{city: Lagos}").error));
  check("example: an array or a bare value is refused (it must be an object)", ex("[1,2]").ok === false && ex("42").ok === false && ex('"hi"').ok === false);
  check("example: over the length limit is refused", ex({ a: "x".repeat(1600) }).ok === false);

  // ── validating an edit ────────────────────────────────────────────────────
  const cur = { name: "Weather Wisp", summary: "Hyperlocal forecasts for travellers.", category: "data", endpointUrl: "https://api.example.com/weather", docsUrl: null, priceUsdc: "0.05", payoutWallet: WALLET, exampleRequest: null };
  const upd = (changes) => rules.validateListingUpdate(changes, cur);
  check("edit: nothing changed is refused", upd({}).ok === false && upd({ name: "Weather Wisp" }).ok === false);
  check("edit: example request alone needs NO review", upd({ exampleRequest: { city: "Lagos" } }).reviewNeeded === false);
  check("edit: payout wallet alone needs NO review", upd({ payoutWallet: WALLET2 }).reviewNeeded === false);
  for (const [label, change] of [["name", { name: "Weather Wisp 2" }], ["description", { summary: "Hyperlocal forecasts, now with radar." }], ["category", { category: "ai" }], ["endpoint", { endpointUrl: "https://api.example.com/v2" }], ["docs link", { docsUrl: "https://docs.example.com/" }], ["price", { priceUsdc: "0.10" }]]) {
    check(`edit: changing the ${label} needs the team to look again`, upd(change).ok && upd(change).reviewNeeded === true, JSON.stringify(upd(change)).slice(0, 80));
  }
  check("edit: only the changed fields are returned", Object.keys(upd({ name: "Weather Wisp", priceUsdc: "0.1" }).changes).join() === "priceUsdc");
  check("edit: an invalid endpoint is refused", upd({ endpointUrl: "http://api.example.com" }).ok === false && upd({ endpointUrl: "https://10.0.0.1/x" }).ok === false);
  check("edit: a price over the cap is refused", upd({ priceUsdc: "9" }).ok === false);
  check("edit: a bad example is refused", upd({ exampleRequest: "nope" }).ok === false);
  check("edit: clearing the example is allowed", rules.validateListingUpdate({ exampleRequest: null }, { ...cur, exampleRequest: '{"a":1}' }).ok === true);
  check("edit: a non-object body is refused", upd(null).ok === false && upd([]).ok === false);

  // ── the owner's actions ───────────────────────────────────────────────────
  const plan = (state, action) => rules.ownerActionPlan(state, action);
  const live = { status: "verified", pausedByOwner: false, verifiedAt: new Date() };
  check("owner: pause a live listing", plan(live, "pause").status === "paused" && plan(live, "pause").pausedByOwner === true);
  check("owner: can't pause something that isn't live", plan({ ...live, status: "submitted" }, "pause").ok === false && plan({ ...live, status: "rejected" }, "pause").ok === false);
  check("owner: resume what they paused", plan({ ...live, status: "paused", pausedByOwner: true }, "resume").status === "verified");
  check("owner: can NOT resume what the team paused", plan({ ...live, status: "paused", pausedByOwner: false }, "resume").status === 409);
  check("owner: can't resume a listing that was never verified", plan({ status: "paused", pausedByOwner: true, verifiedAt: null }, "resume").ok === false);
  check("owner: can remove in any state, but not twice", ["verified", "submitted", "rejected", "paused"].every((s) => plan({ ...live, status: s }, "delete").status === "removed") && plan({ ...live, status: "removed" }, "delete").status === 404);
  check("owner: an unknown action is refused", plan(live, "explode").status === 400);
  const ep = (state, review) => rules.editPlan(state, review);
  check("edit plan: a free change keeps the state", ep(live, false).status === "verified");
  check("edit plan: a reviewed change sends it back to the team", ep(live, true).status === "submitted" && ep(live, true).clearReview === true);
  check("edit plan: editing a rejected listing resubmits it", ep({ ...live, status: "rejected" }, true).status === "submitted");
  check("edit plan: a team-paused listing can't be edited", ep({ ...live, status: "paused", pausedByOwner: false }, false).status === 409);
  check("edit plan: an owner-paused listing can be edited (and a reviewed change resubmits it)", ep({ ...live, status: "paused", pausedByOwner: true }, false).status === "paused" && ep({ ...live, status: "paused", pausedByOwner: true }, true).status === "submitted");

  // ── browsing parameters ───────────────────────────────────────────────────
  const pb = (s) => rules.parseBrowse(new URLSearchParams(s));
  check("browse: defaults", JSON.stringify(pb("")) === JSON.stringify({ q: "", category: null, sort: "featured", free: false }));
  check("browse: parses q, category, sort and free", JSON.stringify(pb("q=  weather   wisp &category=ai&sort=popular&free=1")) === JSON.stringify({ q: "weather wisp", category: "ai", sort: "popular", free: true }));
  check("browse: junk falls back to defaults instead of failing", pb("category=hax&sort=drop table").category === null && pb("sort=drop table").sort === "featured" && pb("free=yes").free === false);
  check("browse: q is capped", pb("q=" + "a".repeat(200)).q.length === 60);

  // ── persistence: create, edit, pause, remove ──────────────────────────────
  const input = (o = {}) => ({ name: "Weather Wisp", summary: "Hyperlocal forecasts for travellers.", category: "data", endpointUrl: "https://api.example.com/weather", priceUsdc: "0", payoutWallet: WALLET, ...o });
  const mk = async (owner, o = {}, verify = true) => {
    const r = await net.createListing(owner, input(o));
    if (!r.ok) throw new Error("create failed: " + r.error);
    if (verify) await net.reviewListing(r.listing.id, "verify", null);
    return r.listing;
  };
  const withEx = await mk("OWNER", { name: "Example Wisp", exampleRequest: { city: "Lagos" } });
  check("create: the example request is saved compact", (await row(withEx.id)).example_request === '{"city":"Lagos"}');
  check("create: a bad example request is refused up front", (await net.createListing("OWNER", input({ name: "Bad Example", exampleRequest: "{nope" }))).ok === false);

  const L = await mk("OWNER", { name: "Rates Wisp", priceUsdc: "0.05" });
  check("edit: a free change (example) keeps it live", (await net.updateListing("OWNER", L.id, { exampleRequest: { pair: "NGN" } })).sentForReview === false && (await row(L.id)).status === "verified");
  check("edit: ...and the example request is updated", (await row(L.id)).example_request === '{"pair":"NGN"}');
  const verifiedAt = (await row(L.id)).verified_at;
  check("edit: someone else's listing is a 404", (await net.updateListing("STRANGER", L.id, { exampleRequest: { a: 1 } })).status === 404);
  check("edit: unknown listing is a 404", (await net.updateListing("OWNER", "99999999-9999-9999-9999-999999999999", { exampleRequest: { a: 1 } })).status === 404);
  const toReview = await net.updateListing("OWNER", L.id, { priceUsdc: "0.10" });
  const afterReview = await row(L.id);
  check("edit: changing the price sends a live listing back to review", toReview.ok && toReview.sentForReview === true && toReview.wasLive === true && afterReview.status === "submitted" && afterReview.verified_at === null);
  check("edit: ...and the new price is stored", afterReview.price_usdc === "0.1");
  check("edit: while in review it is not in the public list", !(await net.listVerified("X")).some((p) => p.id === L.id));
  await net.reviewListing(L.id, "verify", null);
  check("edit: the team verifies it again and it is live", (await row(L.id)).status === "verified");

  // pause / resume
  const P = await mk("OWNER", { name: "Pausable Wisp" });
  check("pause: the owner pauses a live listing", (await net.ownerAction("OWNER", P.id, "pause")).ok && (await row(P.id)).status === "paused" && (await row(P.id)).paused_by_owner === true);
  check("pause: it disappears from the public list and can't be opened by others", !(await net.listVerified("X")).some((p) => p.id === P.id) && (await net.getProviderDetail(P.id, "STRANGER")) === null);
  check("pause: the owner can still open it", (await net.getProviderDetail(P.id, "OWNER"))?.status === "paused");
  check("pause: pausing again is refused", (await net.ownerAction("OWNER", P.id, "pause")).status === 409);
  check("resume: the owner turns it back on", (await net.ownerAction("OWNER", P.id, "resume")).ok && (await row(P.id)).status === "verified" && (await row(P.id)).paused_by_owner === false);
  await net.reviewListing(P.id, "pause", "looks off");
  check("team pause: stored as the team's, not the owner's", (await row(P.id)).status === "paused" && (await row(P.id)).paused_by_owner === false);
  const blocked = await net.ownerAction("OWNER", P.id, "resume");
  check("team pause: the owner can NOT resume it", blocked.status === 409 && /team/.test(blocked.error) && (await row(P.id)).status === "paused");
  check("team pause: the owner can't edit it either", (await net.updateListing("OWNER", P.id, { exampleRequest: { a: 1 } })).status === 409);
  check("pause: only the owner may pause, others get a 404", (await net.ownerAction("STRANGER", L.id, "pause")).status === 404);
  await net.reviewListing(P.id, "verify", null);
  check("team resume: the team can turn it back on", (await row(P.id)).status === "verified");

  // remove
  const D = await mk("OWNER", { name: "Doomed Wisp", priceUsdc: "0.05" });
  await q(`insert into provider_usage (listing_id, caller_user_id, shar, paid_micro, owner_micro, platform_micro) values ($1, 'caller', 0, 50000, 40000, 10000)`, [D.id]);
  await q(`insert into earnings_balances (user_id, available_micro, lifetime_micro) values ('OWNER', 40000, 40000) on conflict (user_id) do update set available_micro = 40000`);
  check("remove: the owner removes a listing", (await net.ownerAction("OWNER", D.id, "delete")).ok && (await row(D.id)).status === "removed" && (await row(D.id)).removed_at !== null);
  check("remove: gone from the public list, the owner's list and the detail page", !(await net.listVerified("X")).some((p) => p.id === D.id) && !(await net.listMine("OWNER")).some((p) => p.id === D.id) && (await net.getProviderDetail(D.id, "OWNER")) === null);
  check("remove: its usage history and the owner's earnings are untouched", (await q(`select 1 from provider_usage where listing_id = $1`, [D.id])).length === 1 && Number((await q(`select available_micro from earnings_balances where user_id = 'OWNER'`))[0].available_micro) === 40000);
  check("remove: it can't be edited, paused, removed again or reviewed", (await net.updateListing("OWNER", D.id, { exampleRequest: { a: 1 } })).status === 404 && (await net.ownerAction("OWNER", D.id, "pause")).status === 404 && (await net.ownerAction("OWNER", D.id, "delete")).status === 404 && (await net.reviewListing(D.id, "verify", null)).status === 404);
  check("remove: it can't be featured", (await net.reviewListing(D.id, "feature", null)).status === 404);
  check("remove: the removed listing doesn't count toward the owner's listing limit... but still exists", (await q(`select count(*)::int n from provider_listings where owner_user_id = 'OWNER'`))[0].n >= 4);

  // ── featured ──────────────────────────────────────────────────────────────
  const A = await mk("O2", { name: "Alpha Wisp", category: "ai" });
  const B = await mk("O3", { name: "Bravo Wisp", category: "defi" });
  const C = await mk("O4", { name: "Charlie Wisp", category: "ai", priceUsdc: "0.2" });
  check("feature: a verified listing can be featured", (await net.reviewListing(A.id, "feature", null)).listing.featured === true && (await row(A.id)).featured === true && (await row(A.id)).featured_at !== null);
  check("feature: only a verified listing can be", (await net.reviewListing((await mk("O5", { name: "Pending Wisp" }, false)).id, "feature", null)).status === 409);
  const order = (await net.listVerified("X")).map((p) => p.name);
  check("feature: featured listings come first by default", order[0] === "Alpha Wisp", order.join());
  check("feature: and carry the flag", (await net.listVerified("X")).find((p) => p.id === A.id).featured === true && (await net.listVerified("X")).find((p) => p.id === B.id).featured === false);
  await net.reviewListing(A.id, "unfeature", null);
  check("feature: unfeature removes it", (await row(A.id)).featured === false && (await row(A.id)).featured_at === null);
  await net.reviewListing(A.id, "feature", null);
  await net.ownerAction("O2", A.id, "pause");
  check("feature: pausing clears it (so it can't come back featured by itself)", (await row(A.id)).featured === false);
  await net.ownerAction("O2", A.id, "resume");
  check("feature: resuming does not re-feature (the team decides)", (await row(A.id)).featured === false);
  await net.reviewListing(B.id, "feature", null);
  await net.reviewListing(B.id, "reject", "no");
  check("feature: rejecting clears it", (await row(B.id)).featured === false);
  await net.reviewListing(B.id, "verify", null);
  await net.reviewListing(B.id, "feature", null);
  await net.updateListing("O3", B.id, { name: "Bravo Wisp Two" });
  check("feature: a reviewed edit clears it", (await row(B.id)).featured === false && (await row(B.id)).status === "submitted");
  await net.reviewListing(B.id, "verify", null);
  check("feature: an unknown action is refused", (await net.reviewListing(A.id, "promote", null)).status === 400);

  // ── search, filters, sorting ──────────────────────────────────────────────
  const names = async (b) => (await net.listVerified("X", { q: "", category: null, sort: "featured", free: false, ...b })).map((p) => p.name).sort();
  check("search: by name, case-insensitive", (await names({ q: "alpha" })).join() === "Alpha Wisp");
  check("search: by description", (await names({ q: "travellers" })).length >= 3);
  check("search: by category word", (await names({ q: "defi" })).join() === "Bravo Wisp Two");
  check("search: no match -> empty", (await names({ q: "zzzzzz" })).length === 0);
  const pct = await mk("O6", { name: "Fifty Percent", summary: "Costs 50% less than the others, honestly.", category: "payments" });
  const under = await mk("O6", { name: "Under_Score", summary: "Has an underscore in the name for the test.", category: "payments" });
  check("search: a % in the query is literal, not a wildcard", (await names({ q: "%" })).join() === "Fifty Percent", (await names({ q: "%" })).join());
  check("search: an _ in the query is literal, not a wildcard", (await names({ q: "_" })).join() === "Under_Score", (await names({ q: "_" })).join());
  check("search: a backslash is safe", (await names({ q: "\\" })).length === 0);
  check("filter: by category", (await names({ category: "ai" })).join() === "Alpha Wisp,Charlie Wisp");
  check("filter: free only", (await names({ free: true })).every((n) => n !== "Charlie Wisp") && (await names({ free: true })).includes("Alpha Wisp"));
  check("filter: category + search combine", (await names({ category: "ai", q: "charlie" })).join() === "Charlie Wisp");
  await q(`insert into provider_usage (listing_id, caller_user_id, shar) select $1, 'c' || g, 0 from generate_series(1, 5) g`, [C.id]);
  await q(`insert into provider_usage (listing_id, caller_user_id, shar) select $1, 'c' || g, 0 from generate_series(1, 2) g`, [A.id]);
  const popular = (await net.listVerified("X", { q: "", category: "ai", sort: "popular", free: false })).map((p) => p.name);
  check("sort: popular puts the most-used first", popular[0] === "Charlie Wisp" && popular[1] === "Alpha Wisp", popular.join());
  const newest = (await net.listVerified("X", { q: "", category: null, sort: "new", free: false })).map((p) => p.name);
  check("sort: new puts the most recently verified first", newest[0] === "Under_Score" && newest[1] === "Fifty Percent" && newest[newest.length - 1] === "Example Wisp", newest.join());
  check("sort: no filters returns everything live", (await names({})).length >= 6);

  // ── the detail page ───────────────────────────────────────────────────────
  const det = await net.getProviderDetail(withEx.id, "STRANGER");
  check("detail: a verified provider opens for anyone", det && det.name === "Example Wisp" && det.mine === false && det.exampleRequest === '{"city":"Lagos"}' && det.host === "api.example.com");
  check("detail: it never exposes the endpoint URL or the payout wallet", !JSON.stringify(det).includes("/weather") && !JSON.stringify(det).includes(WALLET));
  const pend = await mk("OWNER", { name: "Secret Wisp" }, false);
  check("detail: an unverified provider is invisible to others, visible to its owner", (await net.getProviderDetail(pend.id, "STRANGER")) === null && (await net.getProviderDetail(pend.id, "OWNER"))?.status === "submitted");
  check("detail: unknown id -> null", (await net.getProviderDetail("99999999-9999-9999-9999-999999999999", "OWNER")) === null);
  const remix = await net.createListing("O7", input({ name: "Remixed Wisp", remixOfId: withEx.id }));
  await net.reviewListing(remix.listing.id, "verify", null);
  const rd = await net.getProviderDetail(remix.listing.id, "X");
  check("detail: shows what it was remixed from, and counts remixes on the original", rd.remixOf?.name === "Example Wisp" && (await net.getProviderDetail(withEx.id, "X")).remixes === 1);
  const mine = await net.listMine("OWNER");
  check("mine: includes the example request, featured flag and who paused it; excludes removed", mine.every((m) => "exampleRequest" in m && "featured" in m && "pausedByOwner" in m) && !mine.some((m) => m.id === D.id));

  finish();
})().catch((e) => {
  process.stderr.write(`LISTING-MANAGEMENT TEST CRASHED ${(e && e.stack) || e}\n`);
  process.exit(2);
});
