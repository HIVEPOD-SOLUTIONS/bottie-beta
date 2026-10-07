import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { isMissingTable } from "@/lib/shar";
import { topupFromSignature } from "@/lib/topup";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * POST /api/credits/topup  { signature }
 * After sending USDC (Solana) from your own wallet to the deposit address, submit the transaction signature. We check on-chain
 * that it really came from one of YOUR wallets and credit exactly what arrived, once. Submitting it again is harmless.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "credits-topup", 10, 60);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const res = await topupFromSignature(userId, body?.signature);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ credited: res.credited, amountMicro: res.amountMicro, balanceMicro: res.balanceMicro });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "Credits are being set up. Try again soon." }, { status: 503 });
    console.error("[credits/topup]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't add those credits. Nothing was charged: try again." }, { status: 500 });
  }
}
