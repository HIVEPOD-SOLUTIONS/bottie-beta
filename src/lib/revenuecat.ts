import { isCapacitorApp } from "@/hooks/use-admob";

let initialized = false;

/** Initialize RevenueCat. Call once after the user is authenticated. */
export async function initRevenueCat(userId: string): Promise<void> {
  if (!isCapacitorApp() || initialized) return;

  const apiKey = process.env.NEXT_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  if (!apiKey) return;

  try {
    const { Purchases, LOG_LEVEL } = await import("@revenuecat/purchases-capacitor");
    if (process.env.NODE_ENV !== "production") {
      await Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG });
    }
    await Purchases.configure({ apiKey, appUserID: userId });
    initialized = true;
  } catch {
    // RevenueCat unavailable (web preview, test env, etc.)
  }
}

/** Returns the set of active entitlement identifiers, e.g. {"premium": ...} */
export async function getActiveEntitlements(): Promise<Record<string, unknown>> {
  if (!isCapacitorApp() || !initialized) return {};
  try {
    const { Purchases } = await import("@revenuecat/purchases-capacitor");
    const { customerInfo } = await Purchases.getCustomerInfo();
    return customerInfo.entitlements.active as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Returns true if the user has the given entitlement active. */
export async function hasEntitlement(id: string): Promise<boolean> {
  const active = await getActiveEntitlements();
  return id in active;
}

/** Fetch the current RevenueCat offering (products to display on the paywall). */
export async function getCurrentOffering(): Promise<unknown | null> {
  if (!isCapacitorApp() || !initialized) return null;
  try {
    const { Purchases } = await import("@revenuecat/purchases-capacitor");
    const offerings = await Purchases.getOfferings();
    return offerings.current ?? null;
  } catch {
    return null;
  }
}

/** Purchase a package. Pass the package object from getCurrentOffering(). */
export async function purchasePackage(pkg: unknown): Promise<boolean> {
  if (!isCapacitorApp() || !initialized) return false;
  try {
    const { Purchases } = await import("@revenuecat/purchases-capacitor");
    await Purchases.purchasePackage({ aPackage: pkg as never });
    return true;
  } catch {
    return false;
  }
}

/** Restore previous purchases. */
export async function restorePurchases(): Promise<void> {
  if (!isCapacitorApp() || !initialized) return;
  try {
    const { Purchases } = await import("@revenuecat/purchases-capacitor");
    await Purchases.restorePurchases();
  } catch {
    // no-op
  }
}
