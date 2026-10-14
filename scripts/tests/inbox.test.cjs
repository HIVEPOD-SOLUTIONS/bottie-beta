/**
 * Alerts without a push service (src/lib/inbox.ts): the phone's key, the inbox it reads, and the two moments the app tells people about (a
 * claim paid or declined, a provider used). Real code on a real Postgres engine (PGlite) built from the real migrations.
 *
 *     node scripts/tests/inbox.test.cjs
 */
const fs = require("fs");
const path = require("path");
const { PGlite, makeLoader, reporter, req, migrations } = require("./_harness.cjs");
const { check, finish } = reporter();
const { drizzle: drizzleProxy } = req("drizzle-orm/pg-proxy");

const drizzle = (client, opts) =>
  drizzleProxy(async (query, params, method) => ({ rows: (await client.query(query, params, method === "all" ? { rowMode: "array" } : undefined)).rows }), opts);
const schema = makeLoader({})("src/lib/db/schema.ts");
const PAYMENTS_SQL = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;
const read = (p) => fs.readFileSync(path.join(__dirname, "../..", p), "utf8");

let limiterAllows = true;
async function freshDb({ inbox = true } = {}) {
  const client = new PGlite();
  await client.exec(PAYMENTS_SQL);
  for (const stmt of migrations.statements) await client.exec(stmt);
  if (!inbox) await client.exec("drop table notification_inbox; drop table inbox_keys;");
  const db = drizzle(client, { schema });
  const load = makeLoader({ "@/lib/db": { db }, "@/lib/user-rate-limiter": { checkApiLimit: async () => ({ allowed: limiterAllows, headers: {} }) } });
  return { client, inbox: load("src/lib/inbox.ts") };
}

(async () => {
  const { client, inbox } = await freshDb();

  // ── keys
  const a = await inbox.createInboxKey("alice");
  check("key: turning alerts on gives a key of the right shape, once, and a cursor at the start", a.ok && inbox.isInboxKey(a.key) && a.key.startsWith("bvi_") && a.cursor === 0);
  const stored = (await client.query("select key_hash from inbox_keys where user_id = 'alice'")).rows;
  check("key: only a one-way hash is stored, never the key", stored.length === 1 && stored[0].key_hash === inbox.hashInboxKey(a.key) && stored[0].key_hash !== a.key && !JSON.stringify(stored).includes(a.key));
  check("key: junk is not a key (wrong prefix, short, long, spaces, not text)", ["", "bvi_short", `bvi_${"x".repeat(44)}`, `xxx_${"x".repeat(43)}`, `bvi_${"x".repeat(42)} `, 12, null, undefined].every((k) => !inbox.isInboxKey(k)));
  const b = await inbox.createInboxKey("alice");
  check("key: each phone gets its own key", b.ok && b.key !== a.key);
  for (let i = 0; i < 6; i++) {
    await inbox.createInboxKey("alice");
    await new Promise((r) => setTimeout(r, 4));
  }
  check("key: an account keeps only its five newest phones", (await client.query("select count(*)::int as n from inbox_keys where user_id = 'alice'")).rows[0].n === 5);

  // ── messages are only left for people with alerts on
  const dup = await freshDb();
  check("messages: someone who has not turned alerts on gets nothing stored", (await dup.inbox.enqueue("nobody", { title: "x", body: "y" })) === false && (await dup.client.query("select count(*)::int as n from notification_inbox")).rows[0].n === 0);

  const c = await freshDb();
  const ka = await c.inbox.createInboxKey("alice");
  const kb = await c.inbox.createInboxKey("bob");
  const enq = (u, t, extra = {}) => c.inbox.enqueue(u, { title: t, body: `${t} body`, url: "bluvfi://spark", ...extra });
  check("messages: someone with alerts on gets them stored", (await enq("alice", "one")) === true);
  await enq("alice", "two");
  await enq("bob", "for bob");
  await enq("alice", "three");

  // ── reading
  const first = await c.inbox.readInbox(ka.key, ka.cursor);
  check("read: the phone gets its person's messages, oldest first, with a cursor to carry on from", first.ok && first.items.map((i) => i.title).join() === "one,two,three" && first.cursor === first.items[2].id && first.items[0].url === "bluvfi://spark");
  check("read: nobody else's messages come with it", !first.items.some((i) => i.title === "for bob") && (await c.inbox.readInbox(kb.key, 0)).items.map((i) => i.title).join() === "for bob");
  const second = await c.inbox.readInbox(ka.key, first.cursor);
  check("read: asking again from the cursor returns nothing new, and keeps the cursor", second.ok && second.items.length === 0 && second.cursor === first.cursor);
  await enq("alice", "four");
  const third = await c.inbox.readInbox(ka.key, first.cursor);
  check("read: a later message arrives on the next check, once", third.items.map((i) => i.title).join() === "four" && third.cursor > first.cursor);
  check("read: a wrong key is refused (401) and so is a well-shaped key nobody holds", (await c.inbox.readInbox("nope", 0)).status === 401 && (await c.inbox.readInbox(`bvi_${"A".repeat(43)}`, 0)).status === 401);
  check("read: a made-up cursor is treated as the start and never errors", (await c.inbox.readInbox(ka.key, "abc")).ok && (await c.inbox.readInbox(ka.key, -5)).ok && (await c.inbox.readInbox(ka.key, undefined)).ok);
  check("read: using the key is noted", (await c.client.query("select last_used_at from inbox_keys where key_hash = $1", [c.inbox.hashInboxKey(ka.key)])).rows[0].last_used_at !== null);
  await c.client.query("update notification_inbox set created_at = now() - interval '9 days' where title = 'one'");
  check("read: a message older than a week is no longer offered", !(await c.inbox.readInbox(ka.key, 0)).items.some((i) => i.title === "one"));
  for (let i = 0; i < 30; i++) await enq("bob", `bulk ${i}`);
  const page = await c.inbox.readInbox(kb.key, 0);
  const rest = await c.inbox.readInbox(kb.key, page.cursor);
  check("read: a long backlog comes in pages of twenty, and the cursor carries on without gaps or repeats", page.items.length === 20 && rest.items.length === 11 && new Set([...page.items, ...rest.items].map((i) => i.id)).size === 31);

  // ── a key made after messages already exist only shows what comes after
  const late = await c.inbox.createInboxKey("bob");
  check("cursor: a phone that turns alerts on later starts at now, so old messages aren't replayed", late.cursor === rest.cursor && (await c.inbox.readInbox(late.key, late.cursor)).items.length === 0);

  // ── turning off
  await c.inbox.revokeInboxKey("bob", ka.key);
  check("off: nobody can switch off someone else's phone", (await c.inbox.readInbox(ka.key, 0)).ok);
  await c.inbox.revokeInboxKey("alice", ka.key);
  check("off: the owner can, and the key stops working at once", (await c.inbox.readInbox(ka.key, 0)).status === 401);
  await c.client.query("delete from inbox_keys where user_id = 'alice'");
  check("off: with no phone left, nothing more is stored for them", (await enq("alice", "after off")) === false);

  // ── what the messages say
  const m = await freshDb();
  const kk = await m.inbox.createInboxKey("owner");
  await m.client.query("insert into shar_claims (user_id, shar, skr_amount, wallet, status) values ('owner', 1000, '900', 'W', 'paid')");
  const claimId = (await m.client.query("select id from shar_claims limit 1")).rows[0].id;
  await m.inbox.notifyPayout("shar_claim", claimId, "paid");
  await m.inbox.notifyPayout("shar_claim", claimId, "rejected");
  await m.inbox.notifyPayout("shar_claim", "00000000-0000-0000-0000-000000000000", "paid");
  const msgs = (await m.inbox.readInbox(kk.key, 0)).items;
  check("payout: a paid claim says so, with no amount, wallet or address, and opens Activity", msgs[0].title === "Your claim was paid" && msgs[0].url === "bluvfi://activity" && !/\d{2}|\bW\b/.test(msgs[0].body.replace(/SKR/g, "")));
  check("payout: a declined claim says the Shar is back", msgs[1].title === "Your claim was declined" && /Shar is back/.test(msgs[1].body));
  check("payout: an unknown payout tells no one and doesn't fail", msgs.length === 2);
  await m.client.query("insert into provider_listings (owner_user_id, name, slug, summary, category, endpoint_url, payout_wallet, status) values ('owner', 'Weather Now', 'weather-now', 's', 'data', 'https://x.example', 'W', 'verified')");
  const listingId = (await m.client.query("select id from provider_listings limit 1")).rows[0].id;
  await m.inbox.notifyProviderUsed("owner", listingId);
  const used = (await m.inbox.readInbox(kk.key, msgs[1].id)).items[0];
  check("provider used: the owner hears it by the provider's name and is sent to the network screen", used.title === "Your provider was used" && used.body === "Someone just used Weather Now." && used.url === "bluvfi://network");
  limiterAllows = false;
  await m.inbox.notifyProviderUsed("owner", listingId);
  limiterAllows = true;
  check("provider used: past their few alerts a day nothing more is left", (await m.inbox.readInbox(kk.key, used.id)).items.length === 0);

  // ── before the migration has been applied
  const old = await freshDb({ inbox: false });
  const oldKey = await old.inbox.createInboxKey("x");
  const oldRead = await old.inbox.readInbox(`bvi_${"A".repeat(43)}`, 0);
  check("no table yet: turning alerts on says 'being set up' (503), reading is a 503, and leaving a message is a quiet no-op", !oldKey.ok && oldKey.status === 503 && !oldRead.ok && oldRead.status === 503 && (await old.inbox.enqueue("x", { title: "a", body: "b" })) === false);

  // ── wiring and routes
  const payout = read("src/lib/skr-payout.ts");
  check("wiring: every way a payout becomes paid (sent, reconcile twice) and both ways one is declined leaves a message, without waiting", (payout.match(/tellPayout\(kind, id, "paid"\)/g) || []).length === 3 && payout.includes('tellPayout("shar_claim", id, "rejected")') && payout.includes('tellPayout("commission", id, "rejected")') && /void import\("@\/lib\/inbox"\)/.test(payout) && payout.includes(".catch(() => {})"));
  const network = read("src/lib/provider-network.ts");
  check("wiring: a provider's owner is told when someone else uses it, never for their own tests, and never waits on it", network.includes("if (callerUserId === listing.ownerUserId) return;") && network.includes("notifyProviderUsed(listing.ownerUserId, listing.id)") && network.includes("tellOwner(listing, callerUserId)"));
  const keyRoute = read("src/app/api/notifications/key/route.ts");
  check("route: turning alerts on or off needs a sign-in, and turning on is rate limited", keyRoute.includes("verifyAuth") && keyRoute.includes("checkApiLimit") && keyRoute.includes("export async function POST") && keyRoute.includes("export async function DELETE"));
  const inboxRoute = read("src/app/api/notifications/inbox/route.ts");
  check("route: the inbox is read with the phone's key (no sign-in is possible in the background), rate limited per key, never cached, and refuses a bad key before touching the database", !inboxRoute.includes("verifyAuth") && inboxRoute.includes("isInboxKey(key)") && inboxRoute.indexOf("isInboxKey(key)") < inboxRoute.indexOf("readInbox(") && inboxRoute.includes("checkApiLimit(hashInboxKey(key)") && inboxRoute.includes("no-store"));
  const sqlText = read("drizzle/0018_notification_inbox.sql");
  check("migration: safe to run twice, the key is stored hashed, and it doesn't touch push or Firebase", (sqlText.replace(/^--.*$/gm, "").match(/IF NOT EXISTS/g) || []).length === 4 && sqlText.includes('"key_hash" text PRIMARY KEY') && !/firebase|fcm/i.test(sqlText.replace(/^--.*$/gm, "")) && migrations.FILES.indexOf("0018_notification_inbox.sql") > migrations.FILES.indexOf("0017_squads_awards_push.sql"));
  check("no Firebase, Google or Expo push service anywhere in the server's alerts, and no setting to configure", !/fcm|firebase|googleapis|exp\.host|FCM_SERVICE_ACCOUNT/i.test(read("src/lib/inbox.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")) && !fs.existsSync(path.join(__dirname, "../../src/lib/push.ts")));

  finish();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
