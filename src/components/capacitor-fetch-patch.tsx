"use client";

/**
 * CapacitorFetchPatch
 *
 * When the app runs inside a Capacitor WebView from a static bundle, the
 * origin is `capacitor://localhost` (or `http://localhost` on some Android
 * versions).  Relative fetch calls like `fetch('/api/chat')` resolve to
 * `capacitor://localhost/api/chat` — a URL that doesn't exist on the device.
 *
 * This component patches `window.fetch` once at startup to transparently
 * rewrite any request whose path starts with `/api/` to the live Vercel
 * server (`NEXT_PUBLIC_API_URL`).  Every existing fetch call in the app
 * works unchanged — no call-site edits needed.
 *
 * The patch is a no-op in the browser (NEXT_PUBLIC_API_URL is empty / window
 * origin is already the server) so it's safe to include unconditionally.
 */

import { useEffect } from "react";

export function CapacitorFetchPatch() {
  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
    if (!apiUrl) return; // Not a Capacitor build — nothing to patch.

    const isCapacitor =
      typeof window !== "undefined" &&
      (window.location.protocol === "capacitor:" ||
        // Capacitor on some Android versions uses http://localhost
        (window.location.hostname === "localhost" &&
          (window as { Capacitor?: unknown }).Capacitor != null));

    if (!isCapacitor) return;

    const original = window.fetch.bind(window);

    window.fetch = function capacitorFetch(
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> {
      // Rewrite string paths
      if (typeof input === "string" && input.startsWith("/api/")) {
        return original(`${apiUrl}${input}`, init);
      }
      // Rewrite Request objects
      if (input instanceof Request && input.url.startsWith("/api/")) {
        const rewritten = new Request(`${apiUrl}${input.url}`, input);
        return original(rewritten, init);
      }
      // Rewrite URL objects
      if (input instanceof URL && input.pathname.startsWith("/api/")) {
        return original(`${apiUrl}${input.pathname}${input.search}`, init);
      }
      return original(input, init);
    };

    // Cleanup on unmount (HMR / dev only — in production this never runs).
    return () => {
      window.fetch = original;
    };
  }, []);

  return null;
}
