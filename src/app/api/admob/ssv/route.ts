import { NextRequest, NextResponse } from "next/server";
import { verifyAdMobCallback } from "@/lib/admob-ssv";
import { addVerifiedAdCredit } from "@/lib/user-rate-limiter";

/**
 * GET /api/admob/ssv — the callback Google's AdMob calls after a user earns a rewarded ad's reward.
 *
 * Set this URL as the "Server-side verification" callback on the rewarded ad unit in the AdMob console
 * (https://www.bluvfi.xyz/api/admob/ssv). It is deliberately unauthenticated — Google can't hold a Privy session —
 * and safe to expose, because every request is checked against Google's published signing key before it counts.
 * `user_id` is the Privy user id the app passed to the ad (serverSideVerificationOptions.userId).
 *
 * A verified ad becomes a credit the app then claims through POST /api/chat/bonus (see adSsvEnforced).
 */
export async function GET(req: NextRequest) {
  const rawQuery = new URL(req.url).search.replace(/^\?/, "");

  let result;
  try {
    result = await verifyAdMobCallback(rawQuery);
  } catch (err) {
    // Couldn't reach Google's key server: ask Google to retry rather than rejecting a real reward.
    console.error("[admob-ssv] verification unavailable:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Verification unavailable" }, { status: 503 });
  }

  if (!result.ok || !result.userId || !result.transactionId) {
    // Nothing secret here — the query is Google's own callback (parameters and a public signature) — and seeing
    // exactly what arrived is what diagnoses an encoding mismatch.
    console.warn("[admob-ssv] rejected callback:", result.reason, "| query:", rawQuery.slice(0, 700));
    return NextResponse.json({ error: "Invalid callback" }, { status: 403 });
  }

  await addVerifiedAdCredit(result.userId, result.transactionId, result.rewardAmount);
  // 200 whether this was new or a retried delivery: Google only needs to know we got it.
  return new NextResponse("ok", { status: 200 });
}
