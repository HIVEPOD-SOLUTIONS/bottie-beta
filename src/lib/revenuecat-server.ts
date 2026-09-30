/**
 * Server-side RevenueCat entitlement check via REST API.
 * Uses REVENUECAT_SECRET_KEY (never exposed to the browser).
 *
 * Results are cached in-process for 5 minutes per user to avoid
 * hitting RevenueCat on every request.
 */

interface CacheEntry {
  isPremium: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function isUserPremium(userId: string): Promise<boolean> {
  const secretKey = process.env.REVENUECAT_SECRET_KEY;
  if (!secretKey) return false;

  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && now < cached.expiresAt) return cached.isPremium;

  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        next: { revalidate: 0 },
      },
    );

    if (!res.ok) {
      cache.set(userId, { isPremium: false, expiresAt: now + CACHE_TTL_MS });
      return false;
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

    cache.set(userId, { isPremium, expiresAt: now + CACHE_TTL_MS });
    return isPremium;
  } catch {
    return false;
  }
}
