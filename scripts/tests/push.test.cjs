/**
 * Push notifications (src/lib/push.ts): the Firebase sign-in, the phone tokens, and the two moments the app tells people about (a claim
 * paid or declined, a provider used). Real code on a real Postgres engine (PGlite); Firebase's servers are replaced by a fake that records
 * what it was sent.
 *
 *     node scripts/tests/push.test.cjs
 */
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { PGlite, makeLoader, reporter, req, migrations } = require("./_harness.cjs");
const { check, finish } = reporter();
const { drizzle: drizzleProxy } = req("drizzle-orm/pg-proxy");

const drizzle = (client, opts) =>
  drizzleProxy(async (query, params, method) => ({ rows: (await client.query(query, params, method === "all" ? { rowMode: "array" } : undefined)).rows }), opts);
const schema = makeLoader({})("src/lib/db/schema.ts");
const PAYMENTS_SQL = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const ACCOUNT = JSON.stringify({ project_id: "bluvfi-test", client_email: "push@bluvfi-test.iam.gserviceaccount.com", private_key: privateKey });

const env = { FCM_SERVICE_ACCOUNT_JSON: ACCOUNT };
let limiterAllows = true;
const calls = []; // everything the fake Google/Firebase was asked
let fcmReply = () => ({ status: 200, body: "{}" });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, init });
  if (u.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
  const { status, body } = fcmReply(JSON.parse(init.body).message.token);
  return new Response(body, { status });
};
const fcmCalls = () => calls.filter((c) => c.url.includes("fcm.googleapis.com"));

async function freshDb() {
  const client = new PGlite();
  await client.exec(PAYMENTS_SQL);
  for (const stmt of migrations.statements) await client.exec(stmt);
  const db = drizzle(client, { schema });
  const load = makeLoader({
    "@/lib/db": { db },
    "@/lib/server-env": { getServerEnv: (k) => env[k] },
    "@/lib/user-rate-limiter": { checkApiLimit: async () => ({ allowed: limiterAllows, headers: {} }) },
  });
  return { client, push: load("src/lib/push.ts") };
}

const TOKEN = (n) => `fcm-token-${String(n).padStart(3, "0")}-${"x".repeat(40)}`;

(async () => {
  const { client, push } = await freshDb();

  // ── the service account
  check("service account: a real key file is accepted, with its project and email", push.loadServiceAccount(ACCOUNT)?.project_id === "bluvfi-test" && push.loadServiceAccount(ACCOUNT)?.client_email.endsWith("gserviceaccount.com"));
  check("service account: missing, broken or incomplete settings read as 'not configured', never an error", ["", "not json", "{}", JSON.stringify({ project_id: "p", client_email: "e", private_key: "nope" }), JSON.stringify({ project_id: 5 })].every((v) => push.loadServiceAccount(v) === null));
  const sa = push.loadServiceAccount(ACCOUNT);
  const jwt = push.signedAssertion(sa, 1_700_000_000);
  const [h, c, sig] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  check("sign-in: the assertion is an RS256 JWT carrying the right account, scope, audience and a one-hour life", JSON.parse(Buffer.from(h, "base64url").toString()).alg === "RS256" && claims.iss === sa.client_email && claims.scope === "https://www.googleapis.com/auth/firebase.messaging" && claims.aud === "https://oauth2.googleapis.com/token" && claims.exp - claims.iat === 3600);
  check("sign-in: its signature verifies against the account's public key (and fails for a changed payload)", crypto.createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url")) && !crypto.createVerify("RSA-SHA256").update(`${h}.${c}x`).verify(publicKey, Buffer.from(sig, "base64url")));
  const msg = push.fcmMessage("tok", { title: "T".repeat(200), body: "B".repeat(400), url: "bluvfi://spark" });
  check("message: titles and bodies are capped, the screen to open rides along as a string, and it goes out as a high-priority 'spark' channel notification", msg.message.notification.title.length === 80 && msg.message.notification.body.length === 180 && msg.message.data.url === "bluvfi://spark" && msg.message.android.priority === "HIGH" && msg.message.android.notification.channel_id === "spark" && push.fcmMessage("t", { title: "a", body: "b" }).message.data && Object.keys(push.fcmMessage("t", { title: "a", body: "b" }).message.data).length === 0);
  check("dead tokens: an uninstalled app (404 UNREGISTERED) or a malformed token is dropped, a server error or a rate limit is not", push.isDeadToken(404, '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}') && push.isDeadToken(400, '{"error":{"message":"The registration token is not a valid FCM registration token","status":"INVALID_ARGUMENT"}}') && !push.isDeadToken(500, "oops") && !push.isDeadToken(429, "slow down") && !push.isDeadToken(403, "forbidden") && !push.isDeadToken(400, '{"error":{"message":"bad payload field","status":"INVALID_ARGUMENT"}}'));

  // ── tokens
  check("tokens: too short, too long, with spaces or not text are refused (400) and nothing is stored", [undefined, "short", "x".repeat(5000), `${TOKEN(1)} extra`, 12345].every((t) => !push.isPushToken(t)) && (await push.registerPushToken("u1", "short")).ok === false && (await client.query("select count(*)::int as n from push_tokens")).rows[0].n === 0);
  check("tokens: a valid one is stored for the account", (await push.registerPushToken("u1", TOKEN(1))).ok && (await client.query("select user_id from push_tokens where token = $1", [TOKEN(1)])).rows[0].user_id === "u1");
  await push.registerPushToken("u2", TOKEN(1));
  check("tokens: a phone's token belongs to one account at a time: signing in as someone else moves it", (await client.query("select user_id from push_tokens where token = $1", [TOKEN(1)])).rows[0].user_id === "u2" && (await client.query("select count(*)::int as n from push_tokens")).rows[0].n === 1);
  for (let i = 10; i < 18; i++) {
    await push.registerPushToken("u3", TOKEN(i));
    await new Promise((r) => setTimeout(r, 3));
  }
  const kept = (await client.query("select token from push_tokens where user_id = 'u3' order by updated_at desc")).rows.map((r) => r.token);
  check("tokens: an account keeps only its five most recent phones", kept.length === 5 && kept[0] === TOKEN(17) && !kept.includes(TOKEN(10)));
  await push.unregisterPushToken("someone-else", TOKEN(17));
  check("tokens: nobody can switch off another person's phone", (await client.query("select count(*)::int as n from push_tokens where token = $1", [TOKEN(17)])).rows[0].n === 1);
  await push.unregisterPushToken("u3", TOKEN(17));
  check("tokens: the owner can switch it off", (await client.query("select count(*)::int as n from push_tokens where token = $1", [TOKEN(17)])).rows[0].n === 0);

  // ── sending
  delete env.FCM_SERVICE_ACCOUNT_JSON;
  calls.length = 0;
  const off = await push.sendPush("u2", { title: "x", body: "y" });
  check("sending: with no Firebase setting nothing is sent, nothing is called, and it says so", off.configured === false && off.sent === 0 && calls.length === 0 && push.pushConfigured() === false);
  env.FCM_SERVICE_ACCOUNT_JSON = ACCOUNT;
  push.clearPushTokenCache();
  const nobody = await push.sendPush("no-phones", { title: "x", body: "y" });
  check("sending: an account with no registered phone costs no calls at all", nobody.configured && nobody.sent === 0 && calls.length === 0);

  await push.registerPushToken("sender", TOKEN(21));
  await push.registerPushToken("sender", TOKEN(22));
  const ok = await push.sendPush("sender", { title: "Hello", body: "World", url: "bluvfi://shar" });
  check("sending: one sign-in, then one message per phone, each with the bearer token and the right project", ok.sent === 2 && calls.filter((x) => x.url.includes("oauth2")).length === 1 && fcmCalls().length === 2 && fcmCalls().every((x) => x.init.headers.Authorization === "Bearer ya29.test" && x.url.includes("/projects/bluvfi-test/messages:send")));
  check("sending: the message that goes out is the one asked for", JSON.parse(fcmCalls()[0].init.body).message.notification.title === "Hello" && JSON.parse(fcmCalls()[0].init.body).message.data.url === "bluvfi://shar");
  calls.length = 0;
  await push.sendPush("sender", { title: "Again", body: "x" });
  check("sending: the access token is reused for its hour, not asked for again", calls.filter((x) => x.url.includes("oauth2")).length === 0 && fcmCalls().length === 2);

  fcmReply = (t) => (t === TOKEN(21) ? { status: 404, body: '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}' } : { status: 200, body: "{}" });
  const mixed = await push.sendPush("sender", { title: "x", body: "y" });
  const left = (await client.query("select token from push_tokens where user_id = 'sender'")).rows.map((r) => r.token);
  check("sending: a phone that has uninstalled the app is forgotten, and the other phone still gets it", mixed.sent === 1 && mixed.removed === 1 && left.length === 1 && left[0] === TOKEN(22));
  fcmReply = () => ({ status: 500, body: "boom" });
  const failing = await push.sendPush("sender", { title: "x", body: "y" });
  check("sending: a Firebase outage sends nothing, throws nothing and forgets no one", failing.sent === 0 && failing.removed === 0 && (await client.query("select count(*)::int as n from push_tokens where user_id = 'sender'")).rows[0].n === 1);
  fcmReply = () => ({ status: 200, body: "{}" });

  // ── a claim paid or declined
  await client.query("insert into shar_claims (user_id, shar, skr_amount, wallet, status) values ('sender', 1000, '900', 'W', 'paid')");
  const claimId = (await client.query("select id from shar_claims limit 1")).rows[0].id;
  calls.length = 0;
  await push.notifyPayout("shar_claim", claimId, "paid");
  const paidMsg = JSON.parse(fcmCalls()[0].init.body).message;
  check("payout: a paid claim tells its owner, with no amount, wallet or address in the message", paidMsg.notification.title === "Your claim was paid" && !/\d{3}|W\b/.test(paidMsg.notification.body.replace(/SKR/g, "")) && paidMsg.data.url === "bluvfi://activity" && paidMsg.token === TOKEN(22));
  calls.length = 0;
  await push.notifyPayout("shar_claim", claimId, "rejected");
  check("payout: a declined claim says the Shar is back, and where to look", /Shar is back/.test(JSON.parse(fcmCalls()[0].init.body).message.notification.body) && JSON.parse(fcmCalls()[0].init.body).message.notification.title === "Your claim was declined");
  calls.length = 0;
  await push.notifyPayout("shar_claim", "00000000-0000-0000-0000-000000000000", "paid");
  check("payout: an unknown payout notifies no one and doesn't fail", calls.length === 0);

  // ── a provider used
  await client.query("insert into provider_listings (owner_user_id, name, slug, summary, category, endpoint_url, payout_wallet, status) values ('sender', 'Weather Now', 'weather-now', 's', 'data', 'https://x.example', 'W', 'verified')");
  const listingId = (await client.query("select id from provider_listings limit 1")).rows[0].id;
  calls.length = 0;
  await push.notifyProviderUsed("sender", listingId);
  const usedMsg = JSON.parse(fcmCalls()[0].init.body).message;
  check("provider used: the owner hears about it by the provider's name and is sent to the network screen", usedMsg.notification.title === "Your provider was used" && usedMsg.notification.body === "Someone just used Weather Now." && usedMsg.data.url === "bluvfi://network");
  limiterAllows = false;
  calls.length = 0;
  await push.notifyProviderUsed("sender", listingId);
  check("provider used: past the owner's few alerts a day (or in the same minute) nothing is sent", calls.length === 0);
  limiterAllows = true;

  // ── wiring
  const payout = fs.readFileSync(path.join(__dirname, "../../src/lib/skr-payout.ts"), "utf8");
  check("wiring: every way a payout becomes paid (sent, reconcile twice) and both ways one is declined tells the owner, without waiting", (payout.match(/tellPayout\(kind, id, "paid"\)/g) || []).length === 3 && payout.includes('tellPayout("shar_claim", id, "rejected")') && payout.includes('tellPayout("commission", id, "rejected")') && /void import\("@\/lib\/push"\)/.test(payout) && payout.includes(".catch(() => {})"));
  const network = fs.readFileSync(path.join(__dirname, "../../src/lib/provider-network.ts"), "utf8");
  check("wiring: a provider's owner is told when someone else uses it, never for their own tests, and never waits on it", network.includes("if (callerUserId === listing.ownerUserId) return;") && network.includes("notifyProviderUsed(listing.ownerUserId, listing.id)") && network.includes("tellOwner(listing, callerUserId)"));
  const route = fs.readFileSync(path.join(__dirname, "../../src/app/api/push/register/route.ts"), "utf8");
  check("route: register and unregister need sign-in, registering is rate limited, and the answer says whether the server can send yet", route.includes("verifyAuth") && route.includes("checkApiLimit") && route.includes("export async function POST") && route.includes("export async function DELETE") && route.includes("pushConfigured()"));
  const sqlText = fs.readFileSync(path.join(__dirname, "../../drizzle/0017_squads_awards_push.sql"), "utf8");
  check("migration: push_tokens is keyed by token with a user index", sqlText.includes('CREATE TABLE IF NOT EXISTS "push_tokens"') && sqlText.includes('"token" text PRIMARY KEY') && sqlText.includes("push_tokens_user_idx"));
  check("the key is read from the server's settings only, and never logged or returned", !/console\.(log|warn|error)\([^)]*(private_key|ACCOUNT|serviceAccount)/.test(fs.readFileSync(path.join(__dirname, "../../src/lib/push.ts"), "utf8")));

  finish();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
