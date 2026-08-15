import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getServerEnv } from "@/lib/server-env";

const PRIVY_BASE = "https://auth.privy.io/api/v1";

function privyBasicAuth(appId: string, appSecret: string) {
  return Buffer.from(`${appId}:${appSecret}`).toString("base64");
}

export async function GET(req: Request) {
  try {
    await verifyAuth();
  } catch (err) {
    return authErrorResponse(err);
  }

  const { searchParams } = new URL(req.url);
  const walletId = searchParams.get("walletId");
  const token = searchParams.get("token"); // e.g. "base-sepolia:0x036..."

  if (!walletId || !token) {
    return Response.json({ error: "walletId and token are required" }, { status: 400 });
  }

  const appId = getServerEnv("NEXT_PUBLIC_PRIVY_APP_ID");
  const appSecret = getServerEnv("PRIVY_APP_SECRET");
  if (!appId || !appSecret) {
    return Response.json({ error: "Privy credentials not configured" }, { status: 503 });
  }

  const privyRes = await fetch(
    `${PRIVY_BASE}/wallets/${encodeURIComponent(walletId)}/balance?token=${encodeURIComponent(token)}`,
    {
      headers: {
        Authorization: `Basic ${privyBasicAuth(appId, appSecret)}`,
        "privy-app-id": appId,
        "Content-Type": "application/json",
      },
      next: { revalidate: 0 },
    }
  );

  if (!privyRes.ok) {
    return Response.json({ error: "Privy balance fetch failed" }, { status: privyRes.status });
  }

  const data = await privyRes.json();
  // Privy returns { balance, decimals, formatted, symbol }
  return Response.json(data);
}
