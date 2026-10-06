import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getServerEnv } from "@/lib/server-env";
import { forwardRpc, MAX_BODY_BYTES, validateRpcRequest } from "@/lib/solana-rpc-proxy";
import { checkApiLimit } from "@/lib/user-rate-limiter";

export const maxDuration = 20;

/**
 * POST /api/solana/rpc — a single JSON-RPC request, forwarded to the server's own Solana RPC (HELIUS_RPC_URL).
 *
 * Lets the Android app read Seeker data (Seeker Genesis Token, .skr names) without an RPC key inside the APK.
 * Authenticated, rate-limited per user, and limited to the few read-only calls the app makes (see solana-rpc-proxy.ts).
 * 501 when HELIUS_RPC_URL isn't set, which the app treats as "use the fallback".
 */
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  const upstream = getServerEnv("HELIUS_RPC_URL");
  if (!upstream) return NextResponse.json({ error: "Solana RPC is not configured" }, { status: 501 });

  // A name lookup is a handful of calls; this leaves room for the app's refetches and nothing like bulk scanning.
  const limit = await checkApiLimit(userId, "solana-rpc", 30, 1500);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const checked = validateRpcRequest(parsed);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const { status, body } = await forwardRpc(upstream, checked.request);
  return new NextResponse(body, { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
