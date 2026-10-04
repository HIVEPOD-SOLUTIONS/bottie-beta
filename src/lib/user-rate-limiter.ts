import { credit, hit, peek, takeAll } from "@/lib/rate-limit-store";

/**
 * Per-user rate limiter for every AI-cost endpoint.
 *
 * Enforces two independent tiers per endpoint:
 *   • Burst  — short window, stops rapid-fire scripted abuse
 *   • Daily  — rolling 24-hour window (starts at the user's first request), caps total LLM/API spend per user
 *
 * Limits by endpoint:
 *   /api/chat             burst 20/min · daily 200/day   (LLM tokens)
 *   /api/voice/transcribe burst 5/min  · daily 30/day    (Whisper, billed per minute)
 *   /api/activity/narrate burst 10/min · daily 50/day    (Gemini Flash)
 *   /api/insights/weekly  burst 3/min  · daily 10/day    (Gemini Flash, heavy prompt)
 *
 * On top of those: a daily LLM-token budget and a daily tool-call budget for chat (a request is one count however
 * long it runs), a cap on ad-bonus grants, and a generic per-user limiter for cheap-but-metered API routes.
 *
 * Counters are shared across serverless instances (see rate-limit-store.ts), so a cold start or a request that
 * lands on another instance no longer resets anyone's allowance.
 *
 * Why in-route rather than in middleware.ts?
 *   middleware.ts runs before auth — it only knows the IP. User-ID limits require verifyAuth() to have already
 *   run, so they live in each route handler.
 */

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

/** "about 5 hours" / "about 20 minutes" — when the rolling window that blocked the user ends. */
function untilReset(resetAt: number): string {
  const mins = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
  if (mins < 90) return `about ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

// ── Internal helper ───────────────────────────────────────────────────────────

async function enforce(
  userId: string,
  scope: string,
  burstMax: number,
  burstWindowMs: number,
  dailyMax: number,
  burstReason: string,
  dailyReason: (resetIn: string) => string,
): Promise<RateLimitResult> {
  // One round trip each, in parallel; the burst tier is checked first so a too-fast request can still be rejected
  // without having used a daily message (it's refunded below).
  const [burst, daily] = await Promise.all([
    hit(`${scope}:burst:${userId}`, burstWindowMs, burstMax),
    hit(`${scope}:daily:${userId}`, 24 * 60 * 60_000, dailyMax),
  ]);

  if (!burst.allowed) {
    // This attempt didn't run, so it shouldn't cost a daily message.
    if (daily.allowed) await credit(`${scope}:daily:${userId}`, 1);
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

  if (!daily.allowed) {
    const retryAfter = Math.ceil((daily.resetAt - Date.now()) / 1000);
    return {
      allowed: false,
      reason: dailyReason(untilReset(daily.resetAt)),
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
      "X-RateLimit-Remaining-Burst": String(Math.max(0, burstMax - burst.count)),
      "X-RateLimit-Limit-Daily": String(dailyMax),
      "X-RateLimit-Remaining-Daily": String(Math.max(0, dailyMax - daily.count)),
      "X-RateLimit-Reset-Daily": String(Math.ceil(daily.resetAt / 1000)),
    },
  };
}

// ── Per-endpoint checks ───────────────────────────────────────────────────────

/**
 * Give a user back the message a failed request used (the model provider was down, the body was invalid…), so an
 * outage on our side doesn't eat their daily allowance.
 */
export async function refundChat(userId: string): Promise<void> {
  await credit(`chat:daily:${userId}`, 1);
}

/** Ad bonuses are bounded: at most this many grants per user per rolling 24h, each at most MAX_BONUS messages. */
const BONUS_GRANTS_PER_DAY = Number(process.env.CHAT_BONUS_GRANTS_PER_DAY) || 6;
export const MAX_BONUS_PER_GRANT = 10;

/**
 * Grant bonus chat messages by reducing the user's daily count. Called after a rewarded ad is watched.
 * Returns how many messages were granted (0 when the user has used up today's ad bonuses).
 *
 * The server can't see the ad itself, so this is a ceiling, not proof: a determined user can still claim the
 * maximum without watching. Closing that fully needs AdMob server-side verification (SSV callbacks).
 */
export async function grantChatBonus(userId: string, bonus: number, maxPerGrant = MAX_BONUS_PER_GRANT): Promise<number> {
  const amount = Math.max(1, Math.min(Math.floor(bonus) || 1, maxPerGrant));
  const grants = await hit(`chatbonus:daily:${userId}`, 24 * 60 * 60_000, BONUS_GRANTS_PER_DAY);
  if (!grants.allowed) return 0;
  await credit(`chat:daily:${userId}`, amount);
  return amount;
}

// ── Ad bonuses proven by AdMob server-side verification (SSV) ────────────────

/**
 * True once SSV is switched on (ADMOB_SSV_ENABLED=true, after the callback URL is set on the rewarded ad unit in
 * AdMob). From then on a bonus is only granted for an ad Google itself has confirmed; before that the capped,
 * unverified grant above stays in force, so older app builds keep working until you flip the switch.
 */
export const adSsvEnforced = () => process.env.ADMOB_SSV_ENABLED === "true";

const SSV_MAX_PER_CLAIM = 50;

/**
 * Record an ad Google confirmed (called from the signed SSV callback). Idempotent per transaction id, so a retried
 * delivery or a replayed URL can't grant twice. Returns false when the transaction was already counted.
 */
export async function addVerifiedAdCredit(userId: string, transactionId: string, rewardAmount?: number): Promise<boolean> {
  const first = await hit(`ssv:tx:${transactionId}`, 7 * 24 * 60 * 60_000, 1);
  if (!first.allowed) return false;
  const units = Math.max(1, Math.min(Math.floor(rewardAmount ?? 5) || 5, MAX_BONUS_PER_GRANT));
  await hit(`ssv:credit:${userId}`, 24 * 60 * 60_000, 1000, units);
  return true;
}

/**
 * Turn the user's verified ad credits into chat messages (once; the claim empties the bucket atomically). The
 * per-day grant cap still applies as a backstop. `pending` means no verified credit has arrived yet — Google's
 * callback usually lands within a few seconds of the ad finishing, so the app polls.
 */
export async function claimVerifiedBonus(userId: string): Promise<{ granted: number; pending: boolean; capped: boolean }> {
  const credits = await takeAll(`ssv:credit:${userId}`);
  if (credits <= 0) return { granted: 0, pending: true, capped: false };
  const granted = await grantChatBonus(userId, credits, SSV_MAX_PER_CLAIM);
  return { granted, pending: false, capped: granted === 0 };
}

/**
 * /api/chat — AI chat agent (LLM tokens, tool calls).
 * Free:    burst 20/min · daily 200/day
 * Premium: burst 30/min · daily 2000/day
 */
export function checkChatLimit(userId: string, isPremium = false): Promise<RateLimitResult> {
  return enforce(
    userId,
    "chat",
    isPremium ? 30 : 20,
    60_000,
    isPremium ? 2000 : 200,
    "You're sending messages too fast. Please wait a moment before trying again.",
    (resetIn) =>
      isPremium
        ? `You've reached your daily message limit (2000). It resets in ${resetIn}.`
        : `You've reached your daily message limit (200). It resets in ${resetIn}. Upgrade to Bluvfi Premium for 10× more messages, or watch an ad for a bonus.`,
  );
}

/**
 * /api/voice/transcribe — OpenAI Whisper (billed per audio-minute).
 * Free:    burst 5/min  · daily 30/day
 * Premium: burst 15/min · daily 200/day
 */
export function checkVoiceLimit(userId: string, isPremium = false): Promise<RateLimitResult> {
  return enforce(
    userId,
    "voice",
    isPremium ? 15 : 5,
    60_000,
    isPremium ? 200 : 30,
    "You're transcribing too quickly. Please wait before sending another voice message.",
    (resetIn) =>
      isPremium
        ? `You've reached your daily voice transcription limit (200). It resets in ${resetIn}.`
        : `You've reached your daily voice transcription limit (30). It resets in ${resetIn}. Upgrade to Bluvfi Premium for more.`,
  );
}

/**
 * /api/activity/narrate — Gemini Flash (short prompt, cheap per call).
 * Free:    burst 10/min · daily 50/day
 * Premium: burst 20/min · daily 500/day
 */
export function checkNarrateLimit(userId: string, isPremium = false): Promise<RateLimitResult> {
  return enforce(
    userId,
    "narrate",
    isPremium ? 20 : 10,
    60_000,
    isPremium ? 500 : 50,
    "Too many narration requests. Please wait a moment.",
    (resetIn) =>
      isPremium
        ? `You've reached your daily activity narration limit (500). It resets in ${resetIn}.`
        : `You've reached your daily activity narration limit (50). It resets in ${resetIn}. Upgrade to Bluvfi Premium for more.`,
  );
}

/**
 * /api/insights/weekly — Gemini Flash with a large DB-backed prompt.
 * Free:    burst 3/min · daily 10/day
 * Premium: burst 5/min · daily 100/day
 */
export function checkInsightsLimit(userId: string, isPremium = false): Promise<RateLimitResult> {
  return enforce(
    userId,
    "insights",
    isPremium ? 5 : 3,
    60_000,
    isPremium ? 100 : 10,
    "Too many insight requests. Please wait before refreshing again.",
    (resetIn) =>
      isPremium
        ? `You've reached your daily insights limit (100). It resets in ${resetIn}.`
        : `You've reached your daily insights limit (10). It resets in ${resetIn}. Upgrade to Bluvfi Premium for more.`,
  );
}

// ── Cost-based budgets for chat ──────────────────────────────────────────────

const TOKEN_BUDGET_FREE = Number(process.env.CHAT_DAILY_TOKENS_FREE) || 1_000_000;
const TOKEN_BUDGET_PREMIUM = Number(process.env.CHAT_DAILY_TOKENS_PREMIUM) || 10_000_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * A request count says nothing about cost: one chat request can run up to ten model steps over a long history.
 * This daily LLM-token budget is what actually bounds spend. Checked before a request; usage is added after it
 * finishes (recordChatTokens), so the last request of the day may overshoot the budget by one request's worth.
 */
export async function checkChatTokenBudget(userId: string, isPremium = false): Promise<RateLimitResult> {
  const budget = isPremium ? TOKEN_BUDGET_PREMIUM : TOKEN_BUDGET_FREE;
  const used = await peek(`chattokens:daily:${userId}`);
  if (used && used.count >= budget) {
    const retryAfter = Math.ceil((used.resetAt - Date.now()) / 1000);
    return {
      allowed: false,
      reason: `You've used today's AI capacity. It resets in ${untilReset(used.resetAt)}.${isPremium ? "" : " Upgrade to Bluvfi Premium for more."}`,
      retryAfter,
      headers: { "X-RateLimit-Scope": "chat-tokens", "Retry-After": String(retryAfter) },
    };
  }
  return { allowed: true, headers: {} };
}

/** Add a finished chat request's token usage to the user's daily budget. */
export async function recordChatTokens(userId: string, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  // Cap far above any budget so the stored value stays a plain integer.
  await hit(`chattokens:daily:${userId}`, DAY_MS, 2_000_000_000, Math.min(Math.round(tokens), 2_000_000_000));
}

const TOOL_BUDGET_FREE = Number(process.env.CHAT_DAILY_TOOL_CALLS_FREE) || 500;
const TOOL_BUDGET_PREMIUM = Number(process.env.CHAT_DAILY_TOOL_CALLS_PREMIUM) || 5000;

/**
 * The agent's tools call paid third parties (Bitrefill, Cryptorefills, Backpack, market data, Nosana credits). A
 * chat request can run up to ten steps, so cap tool executions per user per day separately from the message count.
 */
export async function checkToolBudget(userId: string, isPremium = false): Promise<RateLimitResult> {
  const max = isPremium ? TOOL_BUDGET_PREMIUM : TOOL_BUDGET_FREE;
  const [burst, daily] = await Promise.all([
    hit(`tools:burst:${userId}`, 60_000, isPremium ? 90 : 60),
    hit(`tools:daily:${userId}`, DAY_MS, max),
  ]);
  if (!burst.allowed || !daily.allowed) {
    const resetAt = !daily.allowed ? daily.resetAt : burst.resetAt;
    return {
      allowed: false,
      reason: !daily.allowed
        ? `You've reached today's limit on actions the assistant can take for you. It resets in ${untilReset(resetAt)}.`
        : "The assistant is running actions too quickly. Please wait a moment.",
      retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
      headers: {},
    };
  }
  return { allowed: true, headers: {} };
}

// ── Generic limiter for metered, non-AI API routes ───────────────────────────

/** Per-user burst + daily limit for routes that spend metered upstream credits (e.g. market data). */
export function checkApiLimit(userId: string, scope: string, burstMax: number, dailyMax: number): Promise<RateLimitResult> {
  return enforce(
    userId,
    scope,
    burstMax,
    60_000,
    dailyMax,
    "Too many requests. Please slow down.",
    (resetIn) => `Daily request limit reached. It resets in ${resetIn}.`,
  );
}
