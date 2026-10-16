import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { isXrplBackendConfigured } from "@/lib/xrplBackend";
import { isSwapChain } from "@/lib/swap-chains";
import { startWalletTopUp, type TopUpPurpose } from "@/lib/chain-topup";

const PURPOSES: TopUpPurpose[] = ["cryptorefills", "stocks", "doma", "wallet"];

/**
 * POST /api/chain-topup — fund the user's Bluvfi wallet on Base from Arc, XRPL,
 * Tempo, Robinhood Chain, Zcash or Hyperliquid (see src/lib/chain-topup.ts).
 *
 * Body: { chain, token: "usdc"|"eth", amount, amountUsd, recipient, refundAddress?, purpose }
 */
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  if (!isXrplBackendConfigured()) {
    return NextResponse.json({ error: "Top-ups from other chains aren't available right now." }, { status: 501 });
  }
  const body = (await req.json().catch(() => null)) as {
    chain?: string; token?: string; amount?: string; amountUsd?: number; recipient?: string; refundAddress?: string; purpose?: string; reference?: string;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  if (!isSwapChain(body.chain)) return NextResponse.json({ error: "chain must be arc, tempo, robinhood, xrpl, zcash or hyperliquid" }, { status: 422 });
  if (body.token !== "usdc" && body.token !== "eth") return NextResponse.json({ error: "token must be usdc or eth" }, { status: 422 });
  if (!body.amount || typeof body.amountUsd !== "number" || !body.recipient) {
    return NextResponse.json({ error: "amount, amountUsd and recipient are required" }, { status: 422 });
  }
  const purpose = PURPOSES.includes(body.purpose as TopUpPurpose) ? (body.purpose as TopUpPurpose) : "wallet";

  try {
    const result = await startWalletTopUp({
      privyDid: userId,
      chain: body.chain,
      token: body.token,
      amount: String(body.amount),
      amountUsd: body.amountUsd,
      recipient: body.recipient,
      refundAddress: body.refundAddress,
      purpose,
      reference: typeof body.reference === "string" ? body.reference : undefined,
    });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Top-up failed";
    console.error("[chain-topup]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
