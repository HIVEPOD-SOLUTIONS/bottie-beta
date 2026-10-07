import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { noteDevice } from "@/lib/abuse";
import { requestWithdrawal } from "@/lib/earnings";
import { isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * POST /api/earnings/withdraw  { wallet }
 * Asks for all your available commission to be paid as SKR to a Solana wallet. The team reviews and sends it; nothing is paid
 * automatically. One withdrawal in progress at a time.
 */
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "earnings-withdraw", 5, 20);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  await noteDevice(req, userId);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const res = await requestWithdrawal(userId, body?.wallet);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ payout: res.payout }, { status: 201 });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "Withdrawals are being set up. Try again soon." }, { status: 503 });
    console.error("[earnings/withdraw]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't request that withdrawal." }, { status: 500 });
  }
}
