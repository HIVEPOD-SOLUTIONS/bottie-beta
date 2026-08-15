import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    privyServerAuthConfigured: Boolean(
      process.env.NEXT_PUBLIC_PRIVY_APP_ID && process.env.PRIVY_APP_SECRET,
    ),
  });
}
