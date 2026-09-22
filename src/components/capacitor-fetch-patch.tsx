"use client";

/**
 * CapacitorFetchPatch
 *
 * When the app runs inside a Capacitor WebView from a static bundle, the
 * origin is `capacitor://localhost` (or `http://localhost` on some Android
 * versions).  Relative fetch calls like `fetch('/api/chat')` resolve to
 * `capacitor://localhost/api/chat` — a URL that doesn't exist on the device.
 *
 * This module patches `window.fetch` synchronously at import time so the
 * rewrite is in place before React mounts — and before React Query fires its
 * first query. Previously the patch lived in a useEffect, which runs AFTER
 * child effects; the price-ticker query (a descendant) would fire before the
 * patch was applied, fail, exhaust its retry budget, and never recover.
 *
 * The patch is a no-op in the browser (NEXT_PUBLIC_API_URL is empty / window
 * origin is already the server) so it's safe to include unconditionally.
 *
 * Also initializes Google AdMob when running as a Capacitor app.
 */

import { useAdMobInit } from "@/hooks/use-admob";

// Apply synchronously at module-load time — before any React component renders.
if (typeof window !== "undefined") {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
  if (apiUrl) {
    const isCapacitor =
      window.location.protocol === "capacitor:" ||
      // Capacitor on some Android versions uses http://localhost
      (window.location.hostname === "localhost" &&
        (window as { Capacitor?: unknown }).Capacitor != null);

    if (isCapacitor) {
      const original = window.fetch.bind(window);

      window.fetch = function capacitorFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        if (typeof input === "string" && input.startsWith("/api/")) {
          return original(`${apiUrl}${input}`, init);
        }
        if (input instanceof Request && input.url.startsWith("/api/")) {
          return original(new Request(`${apiUrl}${input.url}`, input), init);
        }
        if (input instanceof URL && input.pathname.startsWith("/api/")) {
          return original(`${apiUrl}${input.pathname}${input.search}`, init);
        }
        return original(input, init);
      };
    }
  }
}

export function CapacitorFetchPatch() {
  useAdMobInit();
  return null;
}
