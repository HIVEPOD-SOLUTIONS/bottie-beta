import { createSign } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getServerEnv } from "@/lib/server-env";

/**
 * Push notifications to the Android app, sent straight through Firebase Cloud Messaging (the HTTP v1 API). Nothing here needs a
 * third-party push service: the phone gives the app its own FCM token, the app registers it here (push_tokens, drizzle/0017), and
 * this file signs in with a Firebase service account and sends.
 *
 * It is switched on by one server setting, FCM_SERVICE_ACCOUNT_JSON (the whole service-account key file as text). Without it every
 * function here does nothing and returns { configured: false }, so the code can ship before Firebase is set up. A notification never
 * carries anything private: a title, a short line and a screen to open.
 */

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_TOKENS_PER_USER = 5;
const TIMEOUT_MS = 8_000;

export interface PushMessage {
  title: string;
  body: string;
  /** A bluvfi:// link the app opens when the notification is tapped. */
  url?: string;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const missing = (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string } };
  return /(relation|column) .* does not exist/i.test(`${e?.message} ${e?.cause?.message}`);
};

/** The service account from the server setting, or null if it is missing or isn't a usable key. Never throws, never logs the key. */
export function loadServiceAccount(raw: string | undefined = getServerEnv("FCM_SERVICE_ACCOUNT_JSON")): ServiceAccount | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<ServiceAccount>;
    if (typeof j.project_id === "string" && typeof j.client_email === "string" && typeof j.private_key === "string" && j.private_key.includes("BEGIN")) {
      return { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export const pushConfigured = () => loadServiceAccount() !== null;

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** A signed request for a Google access token (RS256 JWT bearer, the standard service-account flow). */
export function signedAssertion(sa: ServiceAccount, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key);
  return `${head}.${claims}.${b64url(signature)}`;
}

let cached: { token: string; expiresAt: number; account: string } | null = null;
export const clearPushTokenCache = () => {
  cached = null;
};

async function accessToken(sa: ServiceAccount): Promise<string | null> {
  const nowMs = Date.now();
  if (cached && cached.account === sa.client_email && cached.expiresAt - 60_000 > nowMs) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(sa) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!json?.access_token) return null;
  cached = { token: json.access_token, expiresAt: nowMs + (json.expires_in ?? 3600) * 1000, account: sa.client_email };
  return json.access_token;
}

/** FCM answers 404 UNREGISTERED (or 400 INVALID_ARGUMENT for the token) once a phone has uninstalled the app: that token is dead. */
export function isDeadToken(status: number, body: string): boolean {
  return (status === 404 && /UNREGISTERED/.test(body)) || (status === 400 && /registration token|INVALID_ARGUMENT/i.test(body) && /token/i.test(body));
}

/** The FCM message for one phone. Data values must all be strings. */
export function fcmMessage(token: string, msg: PushMessage) {
  return {
    message: {
      token,
      notification: { title: msg.title.slice(0, 80), body: msg.body.slice(0, 180) },
      data: msg.url ? { url: msg.url } : {},
      android: { priority: "HIGH", notification: { channel_id: "spark" } },
    },
  };
}

// ── Tokens ────────────────────────────────────────────────────────────────────

/** A plausible FCM token: long, no whitespace. (They are about 160 characters; the bounds are generous.) */
export const isPushToken = (t: unknown): t is string => typeof t === "string" && t.length >= 20 && t.length <= 4096 && !/\s/.test(t);

/** Remembers this phone's token for this account. A token belongs to one account at a time: signing in as someone else moves it. */
export async function registerPushToken(userId: string, token: unknown): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!isPushToken(token)) return { ok: false, status: 400, error: "That isn't a valid notification token." };
  try {
    await db.execute(sql`
      insert into push_tokens (token, user_id, platform) values (${token}, ${userId}, 'android')
      on conflict (token) do update set user_id = excluded.user_id, updated_at = now()`);
    // Keep only the most recently used few, so one account can't pile up addresses.
    await db.execute(sql`
      delete from push_tokens where user_id = ${userId} and token in (
        select token from push_tokens where user_id = ${userId} order by updated_at desc offset ${MAX_TOKENS_PER_USER})`);
    return { ok: true };
  } catch (err) {
    if (missing(err)) return { ok: false, status: 503, error: "Notifications are being set up. Try again soon." };
    throw err;
  }
}

/** Forgets a token, but only if it belongs to this account (nobody can switch off someone else's). */
export async function unregisterPushToken(userId: string, token: unknown): Promise<void> {
  if (!isPushToken(token)) return;
  try {
    await db.execute(sql`delete from push_tokens where token = ${token} and user_id = ${userId}`);
  } catch (err) {
    if (!missing(err)) throw err;
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────

export type PushOutcome = { configured: boolean; sent: number; removed: number };

/** Sends one notification to every phone this account has registered. Never throws: a notification must not break what triggered it. */
export async function sendPush(userId: string, msg: PushMessage): Promise<PushOutcome> {
  const sa = loadServiceAccount();
  if (!sa) return { configured: false, sent: 0, removed: 0 };
  let sent = 0;
  let removed = 0;
  try {
    const tokens = rowsOf<{ token: string }>(await db.execute(sql`select token from push_tokens where user_id = ${userId} order by updated_at desc limit ${MAX_TOKENS_PER_USER}`)).map((r) => r.token);
    if (tokens.length === 0) return { configured: true, sent, removed };
    const auth = await accessToken(sa);
    if (!auth) return { configured: true, sent, removed };
    await Promise.all(
      tokens.map(async (token) => {
        try {
          const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
            body: JSON.stringify(fcmMessage(token, msg)),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (res.ok) {
            sent++;
            return;
          }
          if (isDeadToken(res.status, await res.text().catch(() => ""))) {
            await db.execute(sql`delete from push_tokens where token = ${token}`);
            removed++;
          }
        } catch {
          /* one phone failing must not stop the others */
        }
      }),
    );
  } catch (err) {
    if (!missing(err)) console.warn("[push] couldn't send:", err instanceof Error ? err.message : err);
  }
  return { configured: true, sent, removed };
}

// ── The two moments the app tells people about ─────────────────────────────────────

/** A payout the team just paid or declined. Looks up whose it is, so the caller only needs the kind and id. */
export async function notifyPayout(kind: "shar_claim" | "commission", id: string, outcome: "paid" | "rejected"): Promise<void> {
  const table = kind === "shar_claim" ? sql`shar_claims` : sql`commission_payouts`;
  const owner = rowsOf<{ user_id: string }>(await db.execute(sql`select user_id from ${table} where id = ${id}::uuid`))[0]?.user_id;
  if (!owner) return;
  const what = kind === "shar_claim" ? "claim" : "withdrawal";
  await sendPush(owner, {
    title: outcome === "paid" ? `Your ${what} was paid` : `Your ${what} was declined`,
    body: outcome === "paid" ? "The SKR has been sent to your wallet." : kind === "shar_claim" ? "Open Bluvfi to see why. Your Shar is back in your balance." : "Open Bluvfi to see why. Your money is back in your balance.",
    url: kind === "shar_claim" ? "bluvfi://activity" : "bluvfi://network",
  });
}

/** Someone used a provider. Limited to a few a day per owner, so a busy provider doesn't become a stream of buzzes. */
export async function notifyProviderUsed(ownerUserId: string, listingId: string): Promise<void> {
  const { checkApiLimit } = await import("@/lib/user-rate-limiter");
  const ok = await checkApiLimit(ownerUserId, "push-provider-used", 1, 6);
  if (!ok.allowed) return;
  const name = rowsOf<{ name: string }>(await db.execute(sql`select name from provider_listings where id = ${listingId}::uuid`))[0]?.name ?? "your provider";
  await sendPush(ownerUserId, { title: "Your provider was used", body: `Someone just used ${name.slice(0, 40)}.`, url: "bluvfi://network" });
}
