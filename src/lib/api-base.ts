/**
 * Resolves the correct API base URL for the current environment.
 *
 * - Web (browser): empty string → fetch('/api/...') hits the same origin.
 * - Capacitor WebView (file:// origin): NEXT_PUBLIC_API_URL is required so
 *   relative fetches go to the deployed server instead of file://.
 *
 * Usage:
 *   import { apiBase } from "@/lib/api-base";
 *   const res = await fetch(`${apiBase}/api/chat`, { ... });
 *
 * Set NEXT_PUBLIC_API_URL in your .env.production.local when building for
 * Capacitor, e.g. https://bluvfi.vercel.app
 */
export const apiBase =
  typeof window !== "undefined" &&
  (window.location.protocol === "capacitor:" ||
    window.location.protocol === "file:" ||
    window.location.hostname === "localhost" && window.__CAPACITOR__)
    ? (process.env.NEXT_PUBLIC_API_URL ?? "")
    : "";

// Augment Window so TypeScript knows about the Capacitor global
declare global {
  interface Window {
    __CAPACITOR__?: boolean;
    Capacitor?: unknown;
  }
}
