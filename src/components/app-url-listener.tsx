"use client";

/**
 * AppUrlListener — official Privy Capacitor OAuth implementation.
 * https://docs.privy.io/recipes/capacitor-oauth
 *
 * When Android App Links (Universal Links) bring the Capacitor app to the
 * foreground after Google OAuth, Capacitor fires `appUrlOpen` with the
 * HTTPS redirect URL that includes privy_oauth_code, privy_oauth_state, and
 * privy_oauth_provider as query params.
 *
 * We append those params to the current WebView URL so PrivyProvider
 * auto-detects and exchanges the code — exactly as it does on web.
 */

import { useEffect } from "react";

export function AppUrlListener() {
  useEffect(() => {
    // Only run inside Capacitor
    if (typeof window === "undefined") return;
    if (!(window as unknown as { Capacitor?: unknown }).Capacitor) return;

    let cleanup: (() => void) | null = null;

    import(/* webpackIgnore: true */ "@capacitor/app").then(({ App }) => {
      const listenerPromise = App.addListener("appUrlOpen", (event) => {
        try {
          const deepLinkUrl = new URL(event.url);

          if (
            deepLinkUrl.search &&
            deepLinkUrl.searchParams.has("privy_oauth_code") &&
            deepLinkUrl.searchParams.has("privy_oauth_state") &&
            deepLinkUrl.searchParams.has("privy_oauth_provider")
          ) {
            // Append the OAuth params to the current WebView URL.
            // PrivyProvider will detect them and exchange the code automatically.
            const currentUrl = new URL(window.location.href);
            currentUrl.search = deepLinkUrl.search;
            window.location.assign(currentUrl.toString());
          }
        } catch (error) {
          console.error("[AppUrlListener] Failed to parse deep link URL:", error);
        }
      });

      cleanup = () => {
        listenerPromise.then((handle) => handle.remove());
      };
    });

    return () => {
      cleanup?.();
    };
  }, []);

  return null;
}
