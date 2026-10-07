/**
 * AdMob server-side verification (src/lib/admob-ssv.ts): the real verifier against (1) a callback Google itself signed, kept as a
 * fixture with Google's public key, and (2) callbacks signed here with a throwaway key, covering the re-encodings a hosting layer
 * can introduce, tampering, stale callbacks, key rotation and key caching. No network: the key list is served by a fake fetch.
 *
 *     node scripts/tests/admob-ssv.test.cjs
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { makeLoader, reporter } = require("./_harness.cjs");
const { check, finish } = reporter();

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = publicKey.export({ type: "spki", format: "pem" });
const KEY_ID = "4000000001";

// Serves Google's key list; counts how often it is asked.
const keys = { list: [{ keyId: Number(KEY_ID), pem }], fetches: 0 };
const realFetch = global.fetch;
global.fetch = async () => {
  keys.fetches++;
  return { ok: true, status: 200, json: async () => ({ keys: keys.list }) };
};
const fresh = () => makeLoader({ "node:crypto": crypto })("src/lib/admob-ssv.ts"); // its own key cache

/** A callback signed the way Google does it: every parameter but signature/key_id, sorted by name, joined with &. */
const signed = (params, { order = "sorted", key = privateKey, keyId = KEY_ID } = {}) => {
  const entries = Object.entries(params);
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const content = sorted.map(([k, v]) => `${k}=${v}`).join("&");
  const sig = b64url(crypto.createSign("SHA256").update(content).sign(key));
  const tail = `&signature=${sig}&key_id=${keyId}`;
  if (order === "sorted") return content + tail;
  const shuffled = [...entries].reverse().map(([k, v]) => `${k}=${v}`);
  shuffled.splice(2, 0, `signature=${sig}`); // signature in the middle, as AdMob's Verify URL button sends it
  shuffled.push(`key_id=${keyId}`);
  return shuffled.join("&");
};
const now = Date.now();
const base = { ad_network: "5450213213286189855", ad_unit: "1234567890", reward_amount: "1", reward_item: "AI%20message", timestamp: String(now), transaction_id: "tx-1", user_id: "did%3Aprivy%3Aabc" };

(async () => {
  // ── a callback Google really signed
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/admob-real-callback.json"), "utf8"));
  keys.list = [{ keyId: Number(real.keyId), pem: real.pem }];
  const realResult = await fresh().verifyAdMobCallback(real.rawQuery.replace(/timestamp=\d+/, `timestamp=${now}`).replace(/signature=[^&]+/, (m) => m)).catch((e) => ({ ok: false, reason: String(e) }));
  // The timestamp is part of what was signed, so a real callback can't be re-dated: it verifies as authentic but stale.
  const realExact = await fresh().verifyAdMobCallback(real.rawQuery);
  check("a callback AdMob itself signed (shuffled order, signature in the middle) is recognised as GENUINE", realExact.ok === false && realExact.reason === "stale callback", JSON.stringify(realExact));
  check("...and re-dating it breaks the signature (so a captured callback can't be replayed as fresh)", realResult.ok === false && /bad signature/.test(realResult.reason), JSON.stringify(realResult));
  keys.list = [{ keyId: Number(KEY_ID), pem }];

  // ── callbacks signed with a throwaway key
  const ssv = fresh();
  const v = (q) => ssv.verifyAdMobCallback(q);
  let r = await v(signed(base));
  check("a correctly signed callback is accepted and carries the user, transaction and reward", r.ok === true && r.userId === "did:privy:abc" && r.transactionId === "tx-1" && r.rewardAmount === 1 && r.adUnit === "1234567890", JSON.stringify(r));
  r = await v(signed(base, { order: "shuffled" }));
  check("the same callback with shuffled parameters and the signature in the middle is accepted too", r.ok === true, JSON.stringify(r));
  const plain = signed(base);
  check("a host that re-spells %20 as + still verifies", (await v(plain.replace(/%20/g, "+"))).ok === true);
  check("a host that decodes %3A to : still verifies", (await v(plain.replace(/%3A/g, ":"))).ok === true);
  const { user_id: _omitted, ...noUser } = base;
  r = await v(signed(noUser));
  check("a signed test callback with no user id (the console's Verify URL button) is valid, with nobody to credit", r.ok === true && r.userId === undefined, JSON.stringify(r));

  // ── things that must be refused
  check("tampering with a signed value is refused (the reward cannot be changed)", (await v(plain.replace("reward_amount=1", "reward_amount=99"))).ok === false);
  check("tampering with the user is refused (the reward cannot be redirected)", (await v(plain.replace("abc", "xyz"))).ok === false);
  check("a signature made with a different key is refused", (await v(signed(base, { key: crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey }))).ok === false);
  check("a missing signature is refused", (await v(plain.replace(/&signature=[^&]+/, ""))).reason === "missing signature");
  check("a missing key_id is refused", (await v(plain.replace(/&key_id=\d+/, ""))).ok === false);
  r = await v(signed({ ...base, timestamp: String(now - 25 * 3600 * 1000) }));
  check("a callback older than a day is refused as stale (even though genuine)", r.ok === false && r.reason === "stale callback", JSON.stringify(r));
  r = await v(signed({ ...base, timestamp: String(now * 1000) }));
  check("microsecond timestamps (as in Google's examples) are accepted", r.ok === true, JSON.stringify(r));
  r = await v(signed({ ...base, transaction_id: "tx-2" }, { keyId: "999" }));
  check("an unknown key id is refused", r.ok === false && r.reason === "unknown key_id", JSON.stringify(r));

  // ── key handling
  const cached = fresh();
  keys.fetches = 0;
  await cached.verifyAdMobCallback(signed({ ...base, transaction_id: "a" }));
  await cached.verifyAdMobCallback(signed({ ...base, transaction_id: "b" }));
  await cached.verifyAdMobCallback(signed({ ...base, transaction_id: "c" }));
  check("Google's key list is fetched once and cached across callbacks", keys.fetches === 1, `fetches=${keys.fetches}`);
  const rotated = fresh();
  await rotated.verifyAdMobCallback(signed(base)); // loads the cache without the new key
  const kp2 = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  keys.list.push({ keyId: 4000000002, pem: kp2.publicKey.export({ type: "spki", format: "pem" }) });
  keys.fetches = 0;
  r = await rotated.verifyAdMobCallback(signed({ ...base, transaction_id: "r" }, { key: kp2.privateKey, keyId: "4000000002" }));
  check("a freshly rotated key is picked up by re-fetching once", r.ok === true && keys.fetches === 1, `${JSON.stringify(r)} fetches=${keys.fetches}`);
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  let threw = false;
  try { await fresh().verifyAdMobCallback(signed(base)); } catch { threw = true; }
  check("if Google's key list is unreachable it fails closed (an error, never an accept)", threw === true);

  global.fetch = realFetch;
  finish();
})().catch((e) => {
  global.fetch = realFetch;
  process.stderr.write(`ADMOB-SSV TEST CRASHED ${(e && e.stack) || e}\n`);
  process.exit(2);
});
