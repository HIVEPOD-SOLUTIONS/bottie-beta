import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { url, method, body: requestBody } = body as {
    url?: string;
    method?: string;
    body?: Record<string, unknown>;
  };

  if (!url || typeof url !== "string")
    return NextResponse.json({ error: "url is required" }, { status: 400 });

  const httpMethod = (method === "POST" ? "POST" : "GET") as "GET" | "POST";

  try {
    const { solPayFetch } = await import("@/lib/solana-pay-kit");
    const result = await solPayFetch(url, httpMethod, requestBody);

    // Persist to DB when a payment was actually made
    if (result.paid && !result.error) {
      const dataAny = result.data as Record<string, unknown> | null;
      const paidUsdc = dataAny?.chargedUSDC ?? dataAny?.priceUSDC ?? "0";
      const txSig    = dataAny?.txSignature ?? dataAny?.signature ?? null;
      db.insert(payments).values({
        userId,
        type: "solpay",
        referenceId: txSig != null ? String(txSig) : null,
        description: `Solana nanopayment: ${url}`,
        amountUsdc: String(paidUsdc),
        status: "completed",
        txHash: txSig != null ? String(txSig) : null,
        chain: "solana",
      }).catch(() => {});
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    return NextResponse.json(
      { error: (err as Error)?.message ?? "Payment failed" },
      { status: 500 },
    );
  }
}
