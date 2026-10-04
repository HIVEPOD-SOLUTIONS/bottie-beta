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

/** Base64url (web-safe base64, no padding) → Buffer. */
function fromBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verifies a rewarded-ad callback. `rawQuery` must be the query string exactly as received (without the leading
 * "?"): the signature covers the original bytes up to "&signature=", so it can't be rebuilt from parsed params.
 */
export async function verifyAdMobCallback(rawQuery: string): Promise<SsvResult> {
  const sigAt = rawQuery.indexOf("&signature=");
  if (sigAt < 0) return { ok: false, reason: "missing signature" };

  const signed = rawQuery.slice(0, sigAt);
  const params = new URLSearchParams(rawQuery);
  const signature = params.get("signature");
  const keyId = params.get("key_id");
  if (!signature || !keyId) return { ok: false, reason: "missing signature or key_id" };

  let pem = (await loadKeys()).get(keyId);
  if (!pem) pem = (await loadKeys(true)).get(keyId); // a freshly rotated key
  if (!pem) return { ok: false, reason: "unknown key_id" };

  let valid = false;
  try {
    valid = createVerify("SHA256").update(signed).verify(pem, fromBase64Url(signature));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  const timestamp = Number(params.get("timestamp"));
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > MAX_AGE_MS) {
    return { ok: false, reason: "stale callback" };
  }

  const transactionId = params.get("transaction_id");
  const userId = params.get("user_id");
  if (!transactionId || !userId) return { ok: false, reason: "missing transaction_id or user_id" };

  return {
    ok: true,
    userId,
    transactionId,
    rewardAmount: Number(params.get("reward_amount")) || undefined,
    adUnit: params.get("ad_unit") ?? undefined,
  };
}
