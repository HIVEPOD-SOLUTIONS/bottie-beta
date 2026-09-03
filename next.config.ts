import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";
import path from "path";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

// When NEXT_EXPORT=1 emit a fully-static `out/` for the Capacitor APK.
const isCapacitorBuild = process.env.NEXT_EXPORT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {},

  ...(isCapacitorBuild
    ? {
        output: "export",
        trailingSlash: true,
        images: { unoptimized: true },
        // @base-org/account ships a nested viem that causes type conflicts.
        // Runtime is fine (webpack alias below forces the correct viem).
        typescript: { ignoreBuildErrors: true },
        eslint:     { ignoreDuringBuilds: true },
      }
    : {}),

  // Force every bundler to use the root-level viem package.
  // @walletconnect/utils bundles its own incomplete viem ESM copy inside
  // node_modules/@reown/appkit/.../node_modules/viem/ which is missing
  // parseAvatarRecord.js and recoverAuthorizationAddress.js.
  // Pointing the alias at the package directory (not the entry file) preserves
  // the exports map so sub-path imports like `viem/chains` continue to work.
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
