/**
 * Next.js middleware — runs on every request before it hits a route handler.
 *
 * Responsibilities:
 *  1. Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, …)
 *  2. In-process rate limiting for high-value API routes
 *     (switch to Upstash/Redis for multi-instance / serverless deployments)
 */

import { NextRequest, NextResponse } from "next/server";

// ── Rate limiting ─────────────────────────────────────────────────────────────

interface RateLimitState {
  count: number;
  resetAt: number;
}

// In-memory store (per-process). Good for single-instance; use Upstash for edge/serverless.
const rl = new Map<string, RateLimitState>();

/**
 * Returns true if the request should be blocked.
 * windowMs   – sliding window in milliseconds
 * maxRequests – max allowed in that window per IP
 */
function isRateLimited(key: string, windowMs: number, maxRequests: number): boolean {
  const now = Date.now();
  const state = rl.get(key);

  if (!state || now > state.resetAt) {
    rl.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  state.count += 1;
  if (state.count > maxRequests) return true;
  return false;
}

// ── Rate-limit rules ──────────────────────────────────────────────────────────

const RATE_LIMITS: { path: string; windowMs: number; max: number }[] = [
  { path: "/api/chat",             windowMs: 60_000, max: 30  }, // 30 req/min per IP
  { path: "/api/insights/weekly",  windowMs: 60_000, max: 5   }, // 5 req/min (Gemini is expensive)
  { path: "/api/voice/transcribe", windowMs: 60_000, max: 20  }, // 20 req/min
  { path: "/api/banking",          windowMs: 60_000, max: 60  }, // 60 req/min
  { path: "/api/payments",         windowMs: 60_000, max: 60  },
  { path: "/api/investments",      windowMs: 60_000, max: 30  },
  { path: "/api/swap-quote",       windowMs: 60_000, max: 30  },
];

function applyRateLimit(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl;
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  for (const rule of RATE_LIMITS) {
    if (pathname.startsWith(rule.path)) {
      const key = `${rule.path}:${ip}`;
      if (isRateLimited(key, rule.windowMs, rule.max)) {
        return NextResponse.json(
          { error: "Too many requests. Please slow down." },
          {
            status: 429,
            headers: {
              "Retry-After": String(Math.ceil(rule.windowMs / 1000)),
              "X-RateLimit-Limit": String(rule.max),
            },
          },
        );
      }
      break; // first matching rule wins
    }
  }
  return null;
}

// ── Security headers ──────────────────────────────────────────────────────────

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://bottie.finance";

/**
 * Content Security Policy.
 * Tighten further once you have a stable CDN/font/image origin list.
 */
function buildCSP(): string {
  const directives: Record<string, string[]> = {
    "default-src":   ["'self'"],
    "script-src":    ["'self'", "'unsafe-inline'", "'unsafe-eval'", // required for Next.js hydration
                      "https://auth.privy.io", "https://privy.io",
                      // Privy's custom auth domain for this app (configured on
                      // Privy's dashboard) — OAuth (Google/etc. login) routes
                      // through this instead of auth.privy.io. Confirmed
                      // necessary live: without it, OAuth init is blocked by
                      // this CSP with "Refused to connect... privy.bluvfi.xyz".
                      "https://privy.bluvfi.xyz",
                      "https://challenges.cloudflare.com"],
    "style-src":     ["'self'", "'unsafe-inline'"],
    "img-src":       ["'self'", "data:", "blob:", "https:"],
    "font-src":      ["'self'", "data:"],
    "connect-src":   [
      "'self'",
      APP_URL,
      "https://*.privy.io",
      "https://*.privy.systems",
      "https://privy.bluvfi.xyz", // custom auth domain — see script-src comment above
      "https://*.alchemy.com",
      "https://eth-mainnet.g.alchemy.com",
      "https://polygon-mainnet.g.alchemy.com",
      "https://opt-mainnet.g.alchemy.com",
      "https://arb-mainnet.g.alchemy.com",
      "https://base-mainnet.g.alchemy.com",
      "https://avax-mainnet.g.alchemy.com",
      "https://solana-mainnet.g.alchemy.com",
      "https://api.mainnet-beta.solana.com",
      // Public RPC endpoints used by Circle's Arc AppKit viem adapter.
      // These are the adapter's built-in fallback RPCs for each supported chain.
      // Arbitrum
      "https://arb1.arbitrum.io",
      // Polygon
      "https://polygon.drpc.org",
      // Avalanche
      "https://api.avax.network",
      // Base fallbacks
      "https://mainnet.base.org",
      "https://base.publicnode.com",
      "https://base.meowrpc.com",
      "https://base.drpc.org",
      // Covers ethereum.publicnode.com, polygon.publicnode.com, etc.
      "https://*.publicnode.com",
      "https://*.neon.tech",
      "wss://*.privy.io",
      "https://api.coingecko.com",
      "https://api.lifi.dev",
      "https://li.fi",
      "https://*.li.fi",
      "https://velvet.capital",
      "https://api.velvet.capital",
      "https://api.bitrefill.com",
      "https://generativelanguage.googleapis.com",
      "https://api.nanopay.me",
      // Circle App Kit (stablecoin balance fetches + telemetry)
      "https://gateway-api.circle.com",
      "https://api.circle.com",
      // WalletConnect
      "https://explorer-api.walletconnect.com",
      "https://*.walletconnect.com",
      "wss://*.walletconnect.com",
      "https://*.walletconnect.org",
      "wss://*.walletconnect.org",
    ],
    "frame-src":     ["https://auth.privy.io", "https://privy.io",
                      "https://privy.bluvfi.xyz", // custom auth domain — see script-src comment above
                      "https://challenges.cloudflare.com"],
    "frame-ancestors": ["'none'"],
    "object-src":    ["'none'"],
    "base-uri":      ["'self'"],
    "form-action":   ["'self'"],
    "manifest-src":  ["'self'"],
    "worker-src":    ["'self'", "blob:"],
    "media-src":     ["'self'", "blob:"],
  };

  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

function addSecurityHeaders(response: NextResponse, isProd: boolean): NextResponse {
  const h = response.headers;

  // Prevent clickjacking
  h.set("X-Frame-Options", "DENY");

  // Prevent MIME-type sniffing
  h.set("X-Content-Type-Options", "nosniff");

  // Referrer — send origin only (no path) on cross-origin requests
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions — disable features this app doesn't use
  h.set(
    "Permissions-Policy",
    "camera=(), microphone=(self), geolocation=()",
  );

  // Content Security Policy
  h.set("Content-Security-Policy", buildCSP());

  // HSTS — only in production (localhost doesn't use HTTPS)
  if (isProd) {
    h.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return response;
}

// ── Main middleware ───────────────────────────────────────────────────────────

export function proxy(request: NextRequest): NextResponse {
  const isProd = process.env.NODE_ENV === "production";

  // 1. Rate limiting
  const blocked = applyRateLimit(request);
  if (blocked) return blocked;

  // 2. Pass through, then add security headers to the response
  const response = NextResponse.next();
  return addSecurityHeaders(response, isProd);
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     *  - _next/static  (static assets)
     *  - _next/image   (image optimisation)
     *  - favicon.ico   (browser favicon)
     *  - public files  (images, fonts, manifest …)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|css|js|map)$).*)",
  ],
};
