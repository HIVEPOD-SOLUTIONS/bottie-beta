import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { createClaim, isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * POST /api/shar/claim  { shar: number, wallet: string }
 * Asks for Shar to be paid out as SKR to a Solana wallet. The SKR amount is fixed at claim time and the team sends it;
 * nothing here moves tokens. One open claim per user.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "shar-claim", 5, 20);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await createClaim(userId, body ?? {});
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ claim: result.claim }, { status: 201 });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "Claims are being set up. Try again soon." }, { status: 503 });
    console.error("[shar/claim]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't create the claim." }, { status: 500 });
  }
}
