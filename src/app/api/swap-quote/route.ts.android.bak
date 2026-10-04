import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { BASE_TOKENS, DEFAULT_CHAIN_ID } from "@/lib/constants";

const ALLOWED_TOKENS = new Set(Object.values(BASE_TOKENS));

export async function GET(req: NextRequest) {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const sellToken = sp.get("sellToken");
  const buyToken = sp.get("buyToken");
  const sellAmount = sp.get("sellAmount");
  const taker = sp.get("taker");

  if (!sellToken || !buyToken || !sellAmount || !taker) {
    return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
  }

  if (!ALLOWED_TOKENS.has(sellToken as `0x${string}`) || !ALLOWED_TOKENS.has(buyToken as `0x${string}`)) {
    return NextResponse.json({ error: "Unsupported token address" }, { status: 400 });
  }

  const params = new URLSearchParams({
    chainId: String(DEFAULT_CHAIN_ID),
    sellToken,
    buyToken,
    sellAmount,
    taker,
    slippageBps: "100",
  });

  const res = await fetch(
    `https://api.0x.org/swap/allowance-holder/quote?${params}`,
    {
      headers: {
        "0x-api-key": process.env.ZERO_X_API_KEY!,
        "0x-version": "v2",
      },
    },
  );

  const data = await res.json();
  return NextResponse.json(data, { status: res.ok ? 200 : 502 });
}
