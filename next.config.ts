import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";
import path from "path";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {},

  // De-duplicate nested viem copies bundled inside @walletconnect/utils.
  // Those nested copies have incomplete ESM builds (missing parseAvatarRecord.js
  // and recoverAuthorizationAddress.js). Aliasing to the package *directory*
  // (not the entry file) preserves sub-path exports (viem/chains, viem/accounts)
  // while forcing every importer to use the same root viem install.
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      viem: path.resolve(process.cwd(), "node_modules/viem"),
    };
    return config;
  },

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
