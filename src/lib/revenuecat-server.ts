/**
 * Server-side RevenueCat entitlement check via REST API.
 * Uses REVENUECAT_SECRET_KEY (never exposed to the browser).
 *
 * Results are cached in-process to avoid hitting RevenueCat on every request:
 *   • premium    — 5 minutes
 *   • not premium — 60 seconds, so someone who has just subscribed gets their limits within a minute
 *   • lookup failed — 60 seconds, and the last known answer is kept (a RevenueCat outage or a blip must not drop a
 *     paying user to free limits, and must not make every request retry RevenueCat)
 */

interface CacheEntry {
  isPremium: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
/** Last answer RevenueCat actually gave, kept past its TTL so a failed lookup can fall back to it. */
const lastKnown = new Map<string, boolean>();
const PREMIUM_TTL_MS = 5 * 60 * 1000;
const FREE_TTL_MS = 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;

function remember(userId: string, isPremium: boolean, ttl: number, now: number, known: boolean) {
  cache.set(userId, { isPremium, expiresAt: now + ttl });
  if (known) lastKnown.set(userId, isPremium);
  if (cache.size > 5000) {
    for (const [k, v] of cache) if (now >= v.expiresAt) cache.delete(k);
  }
}

export async function isUserPremium(userId: string): Promise<boolean> {
  const secretKey = process.env.REVENUECAT_SECRET_KEY;
  if (!secretKey) return false;

  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && now < cached.expiresAt) return cached.isPremium;

  const fallback = lastKnown.get(userId) ?? false;
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!res.ok) {
      // Unknown subscribers 404 (they're simply free); anything else is a failed lookup.
      if (res.status === 404) {
        remember(userId, false, FREE_TTL_MS, now, true);
        return false;
      }
      remember(userId, fallback, ERROR_TTL_MS, now, false);
      return fallback;
    }

    const data = await res.json() as {
      subscriber?: { entitlements?: Record<string, { expires_date: string | null }> };
    };

    const entitlements = data.subscriber?.entitlements ?? {};
    const premiumEntry = entitlements["premium"];
    const isPremium =
      !!premiumEntry &&
      (premiumEntry.expires_date === null ||
        new Date(premiumEntry.expires_date).getTime() > now);

    remember(userId, isPremium, isPremium ? PREMIUM_TTL_MS : FREE_TTL_MS, now, true);
    return isPremium;
  } catch {
    remember(userId, fallback, ERROR_TTL_MS, now, false);
    return fallback;
  }
}
