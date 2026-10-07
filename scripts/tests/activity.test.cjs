/**
 * The activity feed (src/lib/activity-rules.ts, src/lib/activity-feed.ts and GET /api/activity/feed): one history across Shar,
 * credits and commission, newest first, a page at a time. The real code on an in-memory Postgres built from the real migrations.
 * The thing that matters most: paging never skips or repeats an entry, even at identical times or microseconds apart.
 *
 *     node scripts/tests/activity.test.cjs
 */
const { makeLoader, freshDb, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

class Res { constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = init.headers ?? {}; } static json(d, i) { return new Res(JSON.stringify(d), i); } }
const auth = { user: "ME", ok: true };
const WALLET = "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM";

(async () => {
  const { client, db } = await freshDb();
  const load = makeLoader({
    "@/lib/db": { db },
    "@/lib/server-env": { getServerEnv: () => undefined },
    "next/server": { NextResponse: Res, NextRequest: class {} },
    "@/lib/auth": { verifyAuth: async () => { if (!auth.ok) throw new Error("nope"); return { userId: auth.user }; } },
    "@/lib/auth-response": { authErrorResponse: () => Res.json({ error: "Unauthorized" }, { status: 401 }) },
    "@/lib/user-rate-limiter": { checkApiLimit: async () => ({ allowed: true, headers: {} }) },
  });
  const rules = load("src/lib/activity-rules.ts");
  const feed = load("src/lib/activity-feed.ts");
  const route = load("src/app/api/activity/feed/route.ts");
  const q = (text, params = []) => client.query(text, params);

  // ── the pure rules ────────────────────────────────────────────────────────
  check("source: the four known ones, anything else means all", ["all", "shar", "credits", "commission"].every((s) => rules.parseSource(s) === s) && rules.parseSource("bogus") === "all" && rules.parseSource(undefined) === "all");
  check("limit: default 25, whole numbers 1 to 50, junk falls back", rules.parseLimit(undefined) === 25 && rules.parseLimit("10") === 10 && rules.parseLimit("1000") === 50 && rules.parseLimit("0") === 25 && rules.parseLimit("-3") === 25 && rules.parseLimit("2.5") === 25 && rules.parseLimit("abc") === 25);
  const cur = { at: "2026-10-05 10:00:00.123456", id: "p:abc" };
  check("cursor: round trips, to the microsecond", JSON.stringify(rules.parseCursor(rules.encodeCursor(cur))) === JSON.stringify(cur));
  check("cursor: junk, wrong time format, no id, control characters and huge values are refused", ["", "nope", "2026-10-05|x", "2026-10-05 10:00:00.123456|", "2026-10-05 10:00:00.123|x", `2026-10-05 10:00:00.123456|a\u0000b`, "x".repeat(200)].every((c) => rules.parseCursor(c) === null) && rules.parseCursor(undefined) === null && rules.parseCursor(5) === null);
  check("iso: the database's text becomes an ISO time in UTC", rules.isoFromDb("2026-10-05 10:00:00.123456") === "2026-10-05T10:00:00.123Z");
  check("claims: wording and state per status", rules.claimEntry("paid").state === "done" && rules.claimEntry("rejected").state === "rejected" && rules.claimEntry("processing").state === "sending" && rules.claimEntry("sent").state === "sending" && rules.claimEntry("requested").state === "review" && rules.claimEntry("requested").title === "SKR claim requested");
  check("withdrawals: wording and state per status", rules.withdrawalEntry("paid").title === "Withdrawn as SKR" && rules.withdrawalEntry("rejected").state === "rejected" && rules.withdrawalEntry("sent").state === "sending" && rules.withdrawalEntry("requested").state === "review");
  check("credits: top-ups, calls and refunds are titled by what they were for; unknown kinds are dropped", rules.creditEntry("topup", null).title === "Added credits" && rules.creditEntry("call", "Weather Wisp").title === "Used Weather Wisp" && rules.creditEntry("refund", "Weather Wisp").title === "Refund: Weather Wisp" && rules.creditEntry("call", null).title === "Used a provider" && rules.creditEntry("mystery", null) === null);
  const sorted = [{ atText: "a", id: "p:1" }, { atText: "b", id: "c:1" }, { atText: "b", id: "u:9" }, { atText: "b", id: "p:5" }].sort(rules.newestFirst).map((x) => `${x.atText}${x.id}`);
  check("merge order: newest first, ties broken by id, byte for byte", sorted.join() === "bu:9,bp:5,bc:1,ap:1", sorted.join());

  // ── data: ME has history in every source; OTHER's must never show up
  const at = (s) => `2026-10-05 ${s}`;
  const pay = (u, type, status, amount, desc, when) => q(`insert into payments (user_id, type, status, amount_usdc, description, created_at) values ($1,$2,$3,$4,$5,$6)`, [u, type, status, amount, desc, when]);
  await pay("ME", "bill", "completed", "25.50", "Steam gift card", at("09:00:00"));
  await pay("ME", "bill", "pending", "40", "Netflix gift card", at("09:30:00"));
  await pay("ME", "bill", "completed", "9.99", "Too small", at("09:31:00")); // earns nothing: not listed
  await pay("ME", "onramp", "completed", "500", "Buy crypto", at("09:32:00")); // not spending: not listed
  await pay("OTHER", "bill", "completed", "100", "Someone else's card", at("09:33:00"));
  const L1 = "11111111-1111-1111-1111-111111111111";
  const L2 = "22222222-2222-2222-2222-222222222222";
  await q(`insert into provider_listings (id, owner_user_id, name, slug, summary, category, endpoint_url, payout_wallet, status) values ($1, 'ME', 'Naira Rate Watch', 'naira', 'Rates', 'payments', 'https://rates.example.com/', $3, 'verified'), ($2, 'OTHER', 'Weather Wisp', 'weather', 'Forecasts', 'data', 'https://api.example.com/', $3, 'verified')`, [L1, L2, WALLET]);
  await q(`insert into provider_usage (listing_id, caller_user_id, shar, paid_micro, owner_micro, platform_micro, created_at) values ($1, 'c1', 1, 0, 0, 0, $2), ($1, 'c2', 0, 100000, 80000, 20000, $3), ($1, 'c3', 1, 100000, 80000, 20000, $4), ($5, 'c4', 1, 0, 0, 0, $6)`, [L1, at("10:00:00"), at("10:30:00"), at("10:45:00"), L2, at("10:50:00")]);
  const claim = (status, shar, when) => q(`insert into shar_claims (user_id, shar, skr_amount, wallet, status, created_at) values ('ME', $1, $2, $3, $4, $5)`, [shar, String(shar * 0.9), WALLET, status, when]);
  await claim("rejected", 1000, at("11:00:00"));
  await claim("paid", 1500, at("11:30:00"));
  await claim("requested", 1200, at("12:00:00"));
  const ledger = (kind, micro, listing, when, user = "ME") => q(`insert into credit_ledger (user_id, kind, amount_micro, listing_id, ref, created_at) values ($1, $2, $3, $4, $5, $6)`, [user, kind, micro, listing, kind === "call" ? null : `r-${when}-${kind}-${user}-${micro}`, when]);
  await ledger("topup", 5_000_000, null, at("13:00:00"));
  await ledger("call", -50_000, L2, at("13:30:00"));
  await ledger("refund", 50_000, L2, at("13:45:00"));
  await ledger("mystery", 1, null, at("13:50:00")); // an unknown kind: ignored
  await ledger("topup", 9_000_000, null, at("13:55:00"), "OTHER");
  const wd = (status, usd, when) => q(`insert into commission_payouts (user_id, usd_micro, wallet, status, created_at) values ('ME', $1, $2, $3, $4)`, [usd, WALLET, status, when]);
  await wd("rejected", 9_000_000, at("14:00:00"));
  await wd("requested", 6_000_000, at("14:30:00"));

  const all = await feed.getActivity("ME", { limit: 50 });
  const byTitle = (t) => all.items.find((i) => i.title === t);
  check("the whole history comes back, only ME's: 14 entries across every source", all.items.length === 14 && all.nextCursor === null && all.ready === true, `${all.items.length} entries`);
  check("newest first", all.items.every((it, i) => i === 0 || all.items[i - 1].at >= it.at));
  check("never includes another user's entries", !all.items.some((i) => /Someone else|Weather Wisp was used/.test(i.title)) && all.items.filter((i) => i.kind === "topup").length === 1);
  check("purchases: counted ones only, with Shar, and a pending one marked pending", byTitle("Steam gift card").amount === 25 && byTitle("Steam gift card").unit === "shar" && byTitle("Steam gift card").state === "done" && byTitle("Netflix gift card").state === "pending" && byTitle("Netflix gift card").amount === 40 && !byTitle("Too small") && !byTitle("Buy crypto"));
  const used = all.items.filter((i) => i.title === "Naira Rate Watch was used");
  check("provider use: one entry for Shar earned, and one for commission earned (80%) per paid use", used.filter((i) => i.source === "shar").length === 2 && used.filter((i) => i.source === "commission").length === 2 && used.filter((i) => i.source === "commission").every((i) => i.amount === 80_000 && i.unit === "usd" && i.kind === "earned"));
  check("claims: signed negative, declined ones are zero, with their SKR amount and state", all.items.find((i) => i.title === "Claimed as SKR").amount === -1500 && all.items.find((i) => i.title === "Claimed as SKR").subtitle === "1350 SKR" && all.items.find((i) => i.title === "Claim declined").amount === 0 && all.items.find((i) => i.title === "Claim declined").state === "rejected" && all.items.find((i) => i.title === "SKR claim requested").state === "review");
  check("credits: top-up +, call −, refund + (micro-USDC), unknown kinds left out", byTitle("Added credits").amount === 5_000_000 && byTitle("Used Weather Wisp").amount === -50_000 && byTitle("Refund: Weather Wisp").amount === 50_000 && all.items.every((i) => i.source !== "credits" || i.unit === "usd") && all.items.filter((i) => i.source === "credits").length === 3);
  check("withdrawals: negative USD, a short wallet, and their states", byTitle("Withdrawal requested").amount === -6_000_000 && byTitle("Withdrawal requested").subtitle === "To 5FHw…UJnM" && byTitle("Withdrawal declined").state === "rejected");
  check("times are ISO in UTC", byTitle("Steam gift card").at === "2026-10-05T09:00:00.000Z");

  // ── filters
  const onlySource = async (s) => (await feed.getActivity("ME", { source: s, limit: 50 })).items;
  check("source=shar: purchases, provider use and claims only", (await onlySource("shar")).every((i) => i.source === "shar") && (await onlySource("shar")).length === 7);
  check("source=credits: ledger entries only", (await onlySource("credits")).length === 3 && (await onlySource("credits")).every((i) => i.source === "credits"));
  check("source=commission: earnings and withdrawals only", (await onlySource("commission")).length === 4 && (await onlySource("commission")).every((i) => i.source === "commission"));

  // ── paging never skips or repeats
  const pageThrough = async (size, source = "all") => {
    const out = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await feed.getActivity("ME", { source, limit: size, cursor });
      out.push(...page.items);
      cursor = page.nextCursor ? rules.parseCursor(page.nextCursor) : null;
      pages++;
    } while (cursor && pages < 100);
    return { out, pages };
  };
  for (const size of [1, 2, 3, 5, 7, 13, 14]) {
    const { out, pages } = await pageThrough(size);
    check(`paging by ${size}: exactly the same entries as one big page, in order, none twice (${pages} pages)`, out.length === 14 && new Set(out.map((i) => i.id)).size === 14 && out.map((i) => i.id).join() === all.items.map((i) => i.id).join());
  }
  check("paging a single source works the same way", (await pageThrough(2, "credits")).out.map((i) => i.id).join() === (await onlySource("credits")).map((i) => i.id).join());
  const first = await feed.getActivity("ME", { limit: 5 });
  check("a full page of a longer history has a next cursor; the last page has none", first.items.length === 5 && first.nextCursor !== null && (await feed.getActivity("ME", { limit: 14 })).nextCursor === null && (await feed.getActivity("ME", { limit: 13 })).nextCursor !== null);

  // identical times and times a microsecond apart, across sources
  const same = "2026-10-06 08:00:00.500000";
  for (let i = 0; i < 4; i++) await ledger("topup", 1_000_000 + i, null, same);
  await q(`insert into shar_claims (user_id, shar, skr_amount, wallet, status, created_at) values ('ME', 1000, '900', $1, 'paid', $2), ('ME', 1001, '900.9', $1, 'rejected', $2)`, [WALLET, same]);
  await q(`insert into commission_payouts (user_id, usd_micro, wallet, status, created_at) values ('ME', 7000000, $1, 'rejected', $2)`, [WALLET, same]);
  await ledger("topup", 2_000_001, null, "2026-10-06 08:00:00.500001"); // one microsecond newer
  await ledger("topup", 2_000_002, null, "2026-10-06 08:00:00.499999"); // one microsecond older
  const ties = await feed.getActivity("ME", { limit: 50 });
  check("the new entries are all there (14 + 9)", ties.items.length === 23);
  check("a microsecond decides the order (newer first, older last among the ties)", ties.items[0].amount === 2_000_001 && ties.items.findIndex((i) => i.amount === 2_000_002) > ties.items.findIndex((i) => i.amount === 1_000_000));
  for (const size of [1, 2, 3, 4, 5, 9]) {
    const { out } = await pageThrough(size);
    check(`paging by ${size} through nine entries at (almost) the same instant: none skipped, none repeated`, out.length === 23 && new Set(out.map((i) => i.id)).size === 23 && out.map((i) => i.id).join() === ties.items.map((i) => i.id).join());
  }

  // ── nothing to show, odd input
  const empty = await feed.getActivity("NOBODY", {});
  check("a person with no history gets an empty page, not an error", empty.items.length === 0 && empty.nextCursor === null && empty.ready === true);
  check("the limit is kept between 1 and 50 even if called directly", (await feed.getActivity("ME", { limit: 1000 })).items.length === 23 && (await feed.getActivity("ME", { limit: 0 })).items.length === 1);

  // ── the route
  const call = async (query, user = "ME") => { auth.user = user; const r = await route.GET({ nextUrl: new URL(`http://x/api/activity/feed${query}`) }); return { status: r.status, body: JSON.parse(r.body), headers: r.headers }; };
  auth.ok = false;
  check("signed out: 401", (await call("")).status === 401);
  auth.ok = true;
  let r = await call("?limit=3&source=credits");
  check("route: pages and filters come from the query string, and the answer is never cached", r.status === 200 && r.body.items.length === 3 && r.body.items.every((i) => i.source === "credits") && r.body.nextCursor && r.headers["Cache-Control"] === "private, no-store");
  const second = await call(`?limit=3&source=credits&cursor=${encodeURIComponent(r.body.nextCursor)}`);
  check("route: the cursor gets the next page, with nothing repeated", second.status === 200 && second.body.items.every((i) => !r.body.items.some((x) => x.id === i.id)));
  check("route: a bad cursor is a 400, not a crash or a silent restart", (await call("?cursor=garbage")).status === 400);
  check("route: unknown source and silly limits fall back to the defaults", (await call("?source=bogus&limit=abc")).body.items.length === 23 && (await call("?limit=9999")).body.items.length === 23);
  check("route: it only ever returns the signed-in user's own history", (await call("", "OTHER")).body.items.every((i) => ["Someone else's card", "Added credits", "Weather Wisp was used"].includes(i.title)) && (await call("", "OTHER")).body.items.length === 3);

  // ── a migration that hasn't been applied yet only hides that part of the history
  await q(`drop table credit_ledger cascade`);
  await q(`drop table commission_payouts cascade`);
  const partial = await feed.getActivity("ME", { limit: 50 });
  check("without the credits and payout tables: those parts are hidden, everything else still shows, and it says so", partial.ready === false && partial.items.some((i) => i.kind === "purchase") && partial.items.some((i) => i.kind === "claim") && partial.items.some((i) => i.kind === "earned") && partial.items.every((i) => i.source !== "credits" && i.kind !== "withdrawal"));
  const bare = await q(`select 1`);
  void bare;
  await q(`drop table shar_claims cascade`);
  await q(`drop table provider_usage cascade`);
  const minimal = await feed.getActivity("ME", { limit: 50 });
  check("without any of the new tables: purchases (from payments) still work", minimal.ready === false && minimal.items.length === 2 && minimal.items.every((i) => i.kind === "purchase"), JSON.stringify(minimal.items.map((i) => i.title)));
  const pagedMinimal = await feed.getActivity("ME", { limit: 1 });
  check("...and paging still works there", pagedMinimal.items.length === 1 && pagedMinimal.nextCursor !== null);

  finish();
})().catch((e) => {
  process.stderr.write(`ACTIVITY TEST CRASHED ${(e && e.stack) || e}\n`);
  process.exit(2);
});
