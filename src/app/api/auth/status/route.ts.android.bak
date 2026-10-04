import { NextResponse } from "next/server";
import { PrivyClient } from "@privy-io/server-auth";
import { getServerEnv, getServerEnvDiagnostic } from "@/lib/server-env";

export function GET() {
  const appId = getServerEnv("NEXT_PUBLIC_PRIVY_APP_ID");
  const appSecret = getServerEnv("PRIVY_APP_SECRET");
  const diagnostics = {
    nodeEnv: process.env.NODE_ENV ?? null,
    runtime: "nodejs",
    checkedAt: new Date().toISOString(),
    appId: getServerEnvDiagnostic("NEXT_PUBLIC_PRIVY_APP_ID"),
    appSecret: getServerEnvDiagnostic("PRIVY_APP_SECRET"),
  };

  let privyClientConstructed = false;
  let privyClientError: string | null = null;
  if (appId && appSecret) {
    try {
      new PrivyClient(appId, appSecret);
      privyClientConstructed = true;
    } catch (err) {
      privyClientError = err instanceof Error ? err.message : "PrivyClient construction failed";
    }
  }

  const privyServerAuthConfigured = Boolean(appId && appSecret && privyClientConstructed);
  console.info("[auth/status] Privy server auth diagnostics", {
    privyServerAuthConfigured,
    privyClientConstructed,
    appId: {
      configured: diagnostics.appId.configured,
      source: diagnostics.appId.source,
      directPresent: diagnostics.appId.direct.present,
      directTrimmedLength: diagnostics.appId.direct.trimmedLength,
    },
    appSecret: {
      configured: diagnostics.appSecret.configured,
      source: diagnostics.appSecret.source,
      directPresent: diagnostics.appSecret.direct.present,
      directTrimmedLength: diagnostics.appSecret.direct.trimmedLength,
      secretStores: diagnostics.appSecret.secretStores.map((store) => ({
        envName: store.envName,
        present: store.present,
        parses: store.parses,
        containsKey: store.containsKey,
        valueTrimmedLength: store.valueTrimmedLength,
      })),
    },
    privyClientError,
  });

  return NextResponse.json({
    privyServerAuthConfigured,
    privyClientConstructed,
    privyClientError,
    diagnostics,
  });
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
