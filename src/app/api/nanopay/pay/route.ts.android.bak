import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { getBuyerClient } from "@/lib/circle-gateway";
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

  const { url } = await req.json().catch(() => ({ url: null }));
  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  try {
    const client = getBuyerClient();

    const support = await client.supports(url);
    if (!support.supported) {
      return NextResponse.json(
        { error: "Target URL does not support Circle Gateway nanopayments" },
        { status: 422 },
      );
    }

    const { data, status, amount, formattedAmount, transaction } = await client.pay(url);
    const paidUsdc = Number(amount) / 1_000_000;

    // Persist to DB
    db.insert(payments).values({
      userId,
      type: "nanopay",
      referenceId: transaction ?? null,
      description: `Circle nanopayment: ${url}`,
      amountUsdc: String(paidUsdc),
      status: "completed",
      txHash: transaction ?? null,
      chain: "evm",
    }).catch(() => {});

    return NextResponse.json({ status, data, paid: formattedAmount, transaction });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Payment failed" }, { status: 500 });
  }
}
