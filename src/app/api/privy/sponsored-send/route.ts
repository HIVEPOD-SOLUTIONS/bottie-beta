/**
 * POST /api/privy/sponsored-send { chainId, to, data?, value? }
 *
 * Layer 1 of lib/evm-pay.ts for apps whose Privy gas mode is "User pays":
 * Privy's client SDKs can't pass `sponsor_options`, so the browser relays the
 * transaction here and we send it from the user's embedded wallet with
 * `sponsor: true, sponsor_options: { asset: "usdc" }` (gas paid in USDC).
 *
 * The wallet is resolved from the verified user — never from the request — and
 * the request is signed with the user's own access token (`user_jwts`).
 *
 * Returns { hash } (the sponsored transaction's hash).
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { PrivyClient } from "@privy-io/node";
import { getUserEmbeddedEvmAddress, verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getServerEnv } from "@/lib/server-env";
import { arcChain } from "@/lib/arc-chain";

// Chains we try to sponsor in user-pays mode (Privy rejects the rest; the client falls through to Layer 2).
// Tempo is excluded — it rejects `sponsor_options`.
const SPONSORED_CHAINS = new Set([1, 8453, 137, 42161, 10, arcChain.id]);
const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

let client: PrivyClient | undefined;
function getClient(): PrivyClient | null {
  if (client) return client;
  const appId = getServerEnv("NEXT_PUBLIC_PRIVY_APP_ID");
  const appSecret = getServerEnv("PRIVY_APP_SECRET");
  if (!appId || !appSecret) return null;
  client = new PrivyClient({ appId, appSecret });
  return client;
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  const body = (await req.json().catch(() => null)) as { chainId?: number; to?: string; data?: string; value?: string } | null;
  const { chainId, to, data, value } = body ?? {};
  if (typeof chainId !== "number" || !SPONSORED_CHAINS.has(chainId)) {
    return NextResponse.json({ error: "unsupported_chain" }, { status: 400 });
  }
  if (typeof to !== "string" || !ADDRESS.test(to)) return NextResponse.json({ error: "invalid_to" }, { status: 400 });
  if (data !== undefined && (typeof data !== "string" || !HEX.test(data))) return NextResponse.json({ error: "invalid_data" }, { status: 400 });
  if (value !== undefined && (typeof value !== "string" || !/^\d+$/.test(value))) return NextResponse.json({ error: "invalid_value" }, { status: 400 });

  const privy = getClient();
  if (!privy) return NextResponse.json({ error: "privy_not_configured" }, { status: 503 });

  const auth = (await headers()).get("authorization");
  // Same token verifyAuth() accepted: explicit Bearer header, else the Privy session cookie.
  const jwt = auth?.startsWith("Bearer ") ? auth.slice(7) : (await cookies()).get("privy-token")?.value ?? null;
  if (!jwt) return NextResponse.json({ error: "missing_token" }, { status: 401 });

  try {
    const address = await getUserEmbeddedEvmAddress(userId);
    if (!address) return NextResponse.json({ error: "no_embedded_wallet" }, { status: 400 });
    const wallet = await privy.wallets().getWalletByAddress({ address });

    const res = await privy.wallets().ethereum().sendTransaction(wallet.id, {
      caip2: `eip155:${chainId}`,
      params: {
        transaction: {
          to,
          ...(data ? { data: data as `0x${string}` } : {}),
          ...(value && value !== "0" ? { value: `0x${BigInt(value).toString(16)}` as `0x${string}` } : {}),
        },
      },
      sponsor: true,
      sponsor_options: { asset: "usdc" },
      authorization_context: { user_jwts: [jwt] },
    });

    return NextResponse.json({ hash: res.hash });
  } catch (err) {
    const message = err instanceof Error ? err.message : "sponsored send failed";
    console.error("[privy/sponsored-send]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
