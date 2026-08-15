import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/server-env";

export function GET() {
  return NextResponse.json({
    privyServerAuthConfigured: Boolean(
      getServerEnv("NEXT_PUBLIC_PRIVY_APP_ID") && getServerEnv("PRIVY_APP_SECRET"),
    ),
  });
}
