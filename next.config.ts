import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {},

  serverExternalPackages: [
    "@solana/pay-kit",
    "@solana-program/token",
    "mppx",
    "@modelcontextprotocol/sdk",
    "@bitrefill/cli",
  ],

  // Security headers applied to every response (belt-and-suspenders alongside middleware).
  // These cover static files that the middleware matcher intentionally skips.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options",        value: "DENY" },
          { key: "X-Content-Type-Options",  value: "nosniff" },
          { key: "Referrer-Policy",         value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
