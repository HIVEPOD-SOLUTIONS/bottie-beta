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

  // De-duplicate nested viem copies bundled inside @walletconnect/utils.
  // When webpack resolves viem's ESM build from a nested node_modules it hits
  // missing files (parseAvatarRecord.js, recoverAuthorizationAddress.js) that
  // only exist in the root viem install. Aliasing forces all importers to use
  // the same copy.
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      viem: require.resolve("viem"),
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
