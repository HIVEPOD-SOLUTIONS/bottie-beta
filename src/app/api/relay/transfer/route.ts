import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { RELAY_CHAINS, RelayError, relayEnabled, relayMaxAtomic, relayUsdcTransfer, type RelayRequest } from "@/lib/gas-relayer";

/**
 * Gasless USDC transfers (payment "layer 1" for the mobile app). Purely additive: nothing else calls this,
 * and with GAS_RELAYER_PRIVATE_KEY unset it just reports itself disabled.
 *
 * GET  /api/relay/transfer  → { enabled, chains, maxUsdc }   (cheap check so the app only asks the user to
 *                              sign when a relay can actually happen)
 * POST /api/relay/transfer  → { hash, chainId }              body: a signed EIP-3009 authorization
 *                              (chainId, from, to, value, validAfter, validBefore, nonce, signature)
 *
 * Failure bodies carry a `code` (RELAY_DISABLED, RELAY_UNFUNDED, RATE_LIMITED, …) so the app can fall through
 * to its next layer instead of showing an error.
 */

export async function GET() {
  return NextResponse.json({
    enabled: relayEnabled(),
    chains: relayEnabled() ? Object.keys(RELAY_CHAINS).map(Number) : [],
    maxUsdc: Number(relayMaxAtomic()) / 1_000_000,
  });
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = (await verifyAuth()).userId;
  } catch (err) {
    return authErrorResponse(err);
  }

  let body: Partial<RelayRequest>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "INVALID_REQUEST" }, { status: 400 });
  }

  const { chainId, from, to, value, validAfter, validBefore, nonce, signature } = body;
  if (
    typeof chainId !== "number" ||
    ![from, to, value, validAfter, validBefore, nonce, signature].every((f) => typeof f === "string")
  ) {
    return NextResponse.json({ error: "Missing or invalid fields", code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await relayUsdcTransfer(userId, { chainId, from, to, value, validAfter, validBefore, nonce, signature } as RelayRequest);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RelayError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("[relay/transfer]", err);
    return NextResponse.json({ error: "Gasless transfer failed.", code: "FAILED" }, { status: 502 });
  }
}
