import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { investments, payments } from "@/lib/db/schema";
import { DEMO_ASSETS } from "@/lib/demo-data";

export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch (err) {
    return authErrorResponse(err);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { symbol, shares, pricePerShare } = body as {
    symbol?: string;
    shares?: string | number;
    pricePerShare?: string | number;
  };

  if (!symbol || !shares) {
    return NextResponse.json(
      { error: "Missing required fields: symbol, shares" },
      { status: 400 }
    );
  }

  const sym = symbol.toUpperCase();
  const market = DEMO_ASSETS.find((a) => a.symbol === sym);
  if (!market) {
    return NextResponse.json(
      { error: `Unknown symbol: ${sym}. Available: ${DEMO_ASSETS.map((a) => a.symbol).join(", ")}` },
      { status: 400 }
    );
  }

  const sharesNum = Number(shares);
  if (isNaN(sharesNum) || sharesNum <= 0) {
    return NextResponse.json(
      { error: "shares must be a positive number" },
      { status: 400 }
    );
  }

  const price = pricePerShare ? Number(pricePerShare) : market.priceUsd;
  const totalUsdc = (sharesNum * price).toFixed(6);

  let txHash: string | null = null;
  let paymentStatus = "completed";

  // Attempt real payment via Circle Gateway if key is set
  if (process.env.CIRCLE_BUYER_PRIVATE_KEY) {
    try {
      const { getBuyerClient } = await import("@/lib/circle-gateway");
      const client = getBuyerClient();
      const resourceUrl = `https://invest.bluvfi.app/${sym}/${sharesNum}`;
      const result = await (client as any).pay?.(resourceUrl).catch(() => null);
      if (result?.transaction) txHash = result.transaction;
    } catch {
      // Fall through to simulation
    }
  }

  try {
    // Check for existing position to merge
    const existing = await db
      .select()
      .from(investments)
      .where(and(eq(investments.userId, userId), eq(investments.symbol, sym)));

    if (existing.length > 0) {
      const pos = existing[0];
      const oldShares = Number(pos.shares);
      const oldAvg = Number(pos.avgPriceUsd);
      const newShares = oldShares + sharesNum;
      const newAvg = (oldShares * oldAvg + sharesNum * price) / newShares;

      await db
        .update(investments)
        .set({
          shares: newShares.toFixed(8),
          avgPriceUsd: newAvg.toFixed(6),
          updatedAt: new Date(),
        })
        .where(eq(investments.id, pos.id));
    } else {
      await db.insert(investments).values({
        userId,
        symbol: sym,
        name: market.name,
        type: market.type,
        shares: sharesNum.toFixed(8),
        avgPriceUsd: price.toFixed(6),
      });
    }

    const [payment] = await db
      .insert(payments)
      .values({
        userId,
        type: "investment",
        referenceId: sym,
        description: `Bought ${sharesNum} share${sharesNum !== 1 ? "s" : ""} of ${market.name} (${sym})`,
        amountUsdc: totalUsdc,
        status: paymentStatus,
        txHash,
      })
      .returning();

    return NextResponse.json({
      success: true,
      symbol: sym,
      name: market.name,
      shares: sharesNum,
      pricePerShare: price,
      totalUsdc,
      paymentId: payment.id,
      txHash,
      simulated: !txHash,
    });
  } catch (err) {
    console.error("[Investments Buy] Error:", err);
    return NextResponse.json({ error: "Purchase failed" }, { status: 500 });
  }
}
