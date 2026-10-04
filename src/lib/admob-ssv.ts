import { createVerify } from "node:crypto";

/**
 * AdMob server-side verification (SSV) for rewarded ads.
 *
 * When SSV is configured on a rewarded ad unit, Google calls our callback URL itself once a user has earned the
 * reward, with the details in the query string and a signature over them. Because the call comes from Google (not
 * from the user's phone) and is signed, it is proof the ad was actually watched.
 *
 *   ad_network, ad_unit, custom_data, reward_amount, reward_item, timestamp, transaction_id, user_id,
 *   then   &signature=<base64url ECDSA-SHA256 over everything before it>&key_id=<id of Google's public key>
 *
 * Google publishes the signing keys at KEYS_URL (rotated occasionally, so they're cached for a day and re-fetched
 * when a request names a key we don't have). See https://developers.google.com/admob/android/ssv.
 */

const KEYS_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** A callback older than this is refused (Google retries failed deliveries for a while, but not for days). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let keyCache: { at: number; byId: Map<string, string> } | null = null;

async function loadKeys(force = false): Promise<Map<string, string>> {
  if (!force && keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.byId;
  const res = await fetch(KEYS_URL, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`AdMob verifier keys unavailable (${res.status})`);
  const json = (await res.json()) as { keys?: { keyId: number | string; pem: string }[] };
  const byId = new Map<string, string>();
  for (const k of json.keys ?? []) byId.set(String(k.keyId), k.pem);
  keyCache = { at: Date.now(), byId };
  return byId;
}

export interface SsvResult {
  ok: boolean;
  /** Why verification failed (for logs / the HTTP response); absent when ok. */
  reason?: string;
  userId?: string;
  transactionId?: string;
  rewardAmount?: number;
  adUnit?: string;
}

/**
 * The strings the signature might cover, most likely first.
 *
 * Google signs every parameter except `signature` and `key_id`, joined as name=value with "&" and sorted by name.
 * (Checked against a real callback from AdMob's "Verify URL" button, which arrives with its parameters in a shuffled
 * order and `signature` in the middle — so "everything before &signature=" is NOT the signed content in general.
 * Real callbacks arrive already sorted, with the two at the end, so both cases come out the same.)
 *
 * Each base form is also tried with the usual re-encodings (spaces as "+" or "%20", "%3A" vs ":") in case a hosting
 * layer re-spelled the query on its way to us.
 */
function signedCandidates(rawQuery: string): string[] {
  const pairs = rawQuery
    .split("&")
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return [i < 0 ? p : p.slice(0, i), i < 0 ? "" : p.slice(i + 1)] as const;
    });
  const rest = pairs.filter(([k]) => k !== "signature" && k !== "key_id");
  const join = (list: readonly (readonly [string, string])[]) => list.map(([k, v]) => `${k}=${v}`).join("&");
  const sigAt = rawQuery.indexOf("&signature=");

  const bases = [join([...rest].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))), join(rest)];
  if (sigAt >= 0) bases.push(rawQuery.slice(0, sigAt));

  const out = new Set<string>();
  for (const base of bases) {
    out.add(base);
    out.add(base.replace(/\+/g, "%20"));
    out.add(base.replace(/%20/g, "+"));
    try {
      const decoded = base.split("&").map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i), decodeURIComponent(p.slice(i + 1).replace(/\+/g, " "))] as const;
      });
      out.add(decoded.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&"));
      out.add(decoded.map(([k, v]) => `${k}=${v}`).join("&"));
    } catch {
      /* malformed escapes: the other forms are all we can try */
    }
  }
  return [...out];
}

/** Base64url (web-safe base64, no padding) → Buffer. */
function fromBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies a rewarded-ad callback. `rawQuery` is the query string as received (without the leading "?"); the values
 * must keep their original encoding because the signature covers those bytes.
 *
 * `userId` / `transactionId` can be absent on a *valid* callback: AdMob's "Verify URL" test button sends a signed
 * sample without a user id, and the caller must answer it 200 (there's just nobody to credit).
 */
export async function verifyAdMobCallback(rawQuery: string): Promise<SsvResult> {
  if (!/(^|&)signature=/.test(rawQuery)) return { ok: false, reason: "missing signature" };

  const params = new URLSearchParams(rawQuery);
  const signature = params.get("signature");
  const keyId = params.get("key_id");
  if (!signature || !keyId) return { ok: false, reason: "missing signature or key_id" };

  let pem = (await loadKeys()).get(keyId);
  if (!pem) pem = (await loadKeys(true)).get(keyId); // a freshly rotated key
  if (!pem) return { ok: false, reason: "unknown key_id" };

  // The signature covers the bytes Google sent. A hosting layer can hand us the same query re-encoded (spaces as
  // "+" or "%20", "%3A" decoded, …), so try the usual equivalent spellings; any one that verifies is genuine, because
  // only Google's private key can produce a signature that matches.
  const sig = fromBase64Url(signature);
  const valid = signedCandidates(rawQuery).some((candidate) => {
    try {
      return createVerify("SHA256").update(candidate).verify(pem, sig);
    } catch {
      return false;
    }
  });
  if (!valid) return { ok: false, reason: `bad signature (key_id ${keyId})` };

  // Google documents the timestamp as epoch time but its examples are in microseconds; accept either.
  let timestamp = Number(params.get("timestamp"));
  if (timestamp > 1e14) timestamp /= 1000;
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > MAX_AGE_MS) {
    return { ok: false, reason: "stale callback" };
  }

  return {
    ok: true,
    userId: params.get("user_id") || undefined,
    transactionId: params.get("transaction_id") || undefined,
    rewardAmount: Number(params.get("reward_amount")) || undefined,
    adUnit: params.get("ad_unit") ?? undefined,
  };
}
