import { useEffect } from "react";

// TODO: remove TEST_MODE and restore real IDs once AdMob ad units are approved
const TEST_MODE = true;
const INTERSTITIAL_AD_ID = TEST_MODE
  ? "ca-app-pub-3940256099942544/1033173712"
  : "ca-app-pub-4986320440788963/6729693281";
const REWARDED_AD_ID = TEST_MODE
  ? "ca-app-pub-3940256099942544/5224354917"
  : "ca-app-pub-4986320440788963/6496567028";

export function isCapacitorApp(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
}

/** Initialize AdMob once when the Capacitor app starts. Call from layout/root. */
export function useAdMobInit() {
  useEffect(() => {
    if (!isCapacitorApp()) return;
    import("@capacitor-community/admob").then(({ AdMob }) => {
      AdMob.initialize({ initializeForTesting: TEST_MODE }).catch(
        (e: unknown) => console.warn("[AdMob] init error:", e),
      );
    });
  }, []);
}

/** Show an interstitial ad. No-op on web. */
export async function showInterstitial(): Promise<void> {
  if (!isCapacitorApp()) return;
  try {
    const { AdMob } = await import("@capacitor-community/admob");
    await AdMob.prepareInterstitial({ adId: INTERSTITIAL_AD_ID });
    await AdMob.showInterstitial();
  } catch (e) {
    console.warn("[AdMob] interstitial error:", e);
  }
}

/**
 * Show a rewarded ad (Capacitor/Android only). No-op on web — never grants the reward.
 * Callers must guard with `isCapacitorApp()` before showing any offer UI.
 * `onRewarded` receives the amount from the AdMob console (e.g. 5 inference units).
 */
export async function showRewardedAd(onRewarded: (amount: number) => void): Promise<void> {
  if (!isCapacitorApp()) return;
  try {
    const { AdMob, RewardAdPluginEvents } = await import("@capacitor-community/admob");
    const listener = await AdMob.addListener(RewardAdPluginEvents.Rewarded, (reward) => {
      onRewarded(reward.amount);
      listener.remove();
    });
    await AdMob.prepareRewardVideoAd({ adId: REWARDED_AD_ID });
    await AdMob.showRewardVideoAd();
  } catch (e) {
    console.warn("[AdMob] rewarded ad error:", e);
  }
}
