/**
 * Per-user rate limiter for every AI-cost endpoint.
 *
 * Enforces two independent tiers per endpoint:
 *   • Burst  — short window, stops rapid-fire scripted abuse
 *   • Daily  — 24-hour window, caps total LLM/API spend per user
 *
 * Limits by endpoint:
 *   /api/chat            burst 20/min  · daily 200/day   (LLM tokens)
 *   /api/voice/transcribe burst 5/min  · daily 30/day    (Whisper, billed per minute)
 *   /api/activity/narrate burst 10/min · daily 50/day    (Gemini Flash)
 *   /api/insights/weekly  burst 3/min  · daily 10/day    (Gemini Flash, heavy prompt)
 *
 * Why in-route rather than in proxy.ts?
 *   proxy.ts runs before auth — it only knows the IP. User-ID limits require
 *   verifyAuth() to have already run, so they live in each route handler.
 *
 * ── Scaling to multiple Vercel instances ─────────────────────────────────────
 * Swap the in-process Map for Upstash Redis (exact same API surface):
 *
 *   import { Ratelimit } from "@upstash/ratelimit";
 *   import { Redis }     from "@upstash/redis";
 *   // One ratelimit instance per endpoint, replace check() calls below.
 *   const rl = new Ratelimit({ redis: Redis.fromEnv(), limiter: Ratelimit.slidingWindow(20, "1 m") });
 *   const { success, remaining, reset } = await rl.limit(userId);
 *
 * The limits, reason strings, and header names stay identical — only the
 * storage backend changes.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();

/** Evict expired buckets every 15 minutes to prevent unbounded memory growth. */
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of store) {
      if (now > bucket.resetAt) store.delete(key);
    }
  }, 15 * 60 * 1000);
}

function check(
  key: string,
  windowMs: number,
  max: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let bucket = store.get(key);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 1, resetAt: now + windowMs };
    store.set(key, bucket);
    return { allowed: true, remaining: max - 1, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  const remaining = Math.max(0, max - bucket.count);
  return { allowed: bucket.count <= max, remaining, resetAt: bucket.resetAt };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  /** Human-readable reason when not allowed — safe to send to the client. */
  reason?: string;
  /** Seconds until the relevant window resets. */
  retryAfter?: number;
  /** Response headers to include (on 429 and on 200 for quota visibility). */
  headers: Record<string, string>;
}

// ── Internal helper ───────────────────────────────────────────────────────────

function enforce(
  userId: string,
  scope: string,
  burstMax: number,
  burstWindowMs: number,
  dailyMax: number,
  burstReason: string,
  dailyReason: string,
): RateLimitResult {
  const burst = check(`${scope}:burst:${userId}`, burstWindowMs, burstMax);

  if (!burst.allowed) {
    const retryAfter = Math.ceil((burst.resetAt - Date.now()) / 1000);
    return {
      allowed: false,
      reason: burstReason,
      retryAfter,
      headers: {
        "X-RateLimit-Scope": scope,
        "X-RateLimit-Limit-Burst": String(burstMax),
        "X-RateLimit-Remaining-Burst": "0",
        "X-RateLimit-Reset-Burst": String(Math.ceil(burst.resetAt / 1000)),
        "Retry-After": String(retryAfter),
      },
    };
  }

  const daily = check(`${scope}:daily:${userId}`, 24 * 60 * 60_000, dailyMax);

  if (!daily.allowed) {
    const retryAfter = Math.ceil((daily.resetAt - Date.now()) / 1000);
    return {
      allowed: false,
      reason: dailyReason,
      retryAfter,
      headers: {
        "X-RateLimit-Scope": scope,
        "X-RateLimit-Limit-Daily": String(dailyMax),
        "X-RateLimit-Remaining-Daily": "0",
        "X-RateLimit-Reset-Daily": String(Math.ceil(daily.resetAt / 1000)),
        "Retry-After": String(retryAfter),
      },
    };
  }

  // Allowed — return quota headers so the client can surface remaining counts.
  return {
    allowed: true,
    headers: {
      "X-RateLimit-Scope": scope,
      "X-RateLimit-Limit-Burst": String(burstMax),
      "X-RateLimit-Remaining-Burst": String(burst.remaining),
      "X-RateLimit-Limit-Daily": String(dailyMax),
      "X-RateLimit-Remaining-Daily": String(daily.remaining),
    },
  };
}

// ── Per-endpoint checks ───────────────────────────────────────────────────────

/**
 * Grant bonus chat messages by reducing the user's daily count.
 * Called after a rewarded ad is watched — grants +50 messages.
 */
export function grantChatBonus(userId: string, bonus: number): void {
  const key = `chat:daily:${userId}`;
  const bucket = store.get(key);
  if (bucket) {
    bucket.count = Math.max(0, bucket.count - bonus);
  }
}

/**
 * /api/chat — AI chat agent (LLM tokens, tool calls).
 * Free:    burst 20/min · daily 200/day
 * Premium: burst 30/min · daily 2000/day
 */
export function checkChatLimit(userId: string, isPremium = false): RateLimitResult {
  return enforce(
    userId,
    "chat",
    isPremium ? 30 : 20,
    60_000,
    isPremium ? 2000 : 200,
    "You're sending messages too fast. Please wait a moment before trying again.",
    isPremium
      ? "You've reached your daily message limit (2000). Your quota resets at midnight UTC."
      : "You've reached your daily message limit (200). Upgrade to Bluvfi Premium for 10× more messages, or watch an ad for a bonus.",
  );
}

/**
 * /api/voice/transcribe — OpenAI Whisper (billed per audio-minute).
 * Free:    burst 5/min  · daily 30/day
 * Premium: burst 15/min · daily 200/day
 */
export function checkVoiceLimit(userId: string, isPremium = false): RateLimitResult {
  return enforce(
    userId,
    "voice",
    isPremium ? 15 : 5,
    60_000,
    isPremium ? 200 : 30,
    "You're transcribing too quickly. Please wait before sending another voice message.",
    isPremium
      ? "You've reached your daily voice transcription limit (200). Your quota resets at midnight UTC."
      : "You've reached your daily voice transcription limit (30). Upgrade to Bluvfi Premium for more.",
  );
}

/**
 * /api/activity/narrate — Gemini Flash (short prompt, cheap per call).
 * Free:    burst 10/min · daily 50/day
 * Premium: burst 20/min · daily 500/day
 */
export function checkNarrateLimit(userId: string, isPremium = false): RateLimitResult {
  return enforce(
    userId,
    "narrate",
    isPremium ? 20 : 10,
    60_000,
    isPremium ? 500 : 50,
    "Too many narration requests. Please wait a moment.",
    isPremium
      ? "You've reached your daily activity narration limit (500). Your quota resets at midnight UTC."
      : "You've reached your daily activity narration limit (50). Upgrade to Bluvfi Premium for more.",
  );
}

/**
 * /api/insights/weekly — Gemini Flash with a large DB-backed prompt.
 * Free:    burst 3/min · daily 10/day
 * Premium: burst 5/min · daily 100/day
 */
export function checkInsightsLimit(userId: string, isPremium = false): RateLimitResult {
  return enforce(
    userId,
    "insights",
    isPremium ? 5 : 3,
    60_000,
    isPremium ? 100 : 10,
    "Too many insight requests. Please wait before refreshing again.",
    isPremium
      ? "You've reached your daily insights limit (100). Your quota resets at midnight UTC."
      : "You've reached your daily insights limit (10). Upgrade to Bluvfi Premium for more.",
  );
}
