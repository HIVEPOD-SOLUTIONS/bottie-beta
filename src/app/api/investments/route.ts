import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { investments } from "@/lib/db/schema";
import { DEMO_ASSETS } from "@/lib/demo-data";

// Build a lookup map from DEMO_ASSETS (source of truth for price + icon)
const ASSET_MAP = Object.fromEntries(DEMO_ASSETS.map((a) => [a.symbol, a]));

export async function GET() {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const positions = await db
      .select()
      .from(investments)
      .where(eq(investments.userId, userId))
      .orderBy(desc(investments.createdAt));

    const portfolio = positions.map((pos) => {
      const market = ASSET_MAP[pos.symbol];
      const currentPrice = market?.priceUsd ?? Number(pos.avgPriceUsd);
      const sharesNum = Number(pos.shares);
      const avgPrice = Number(pos.avgPriceUsd);
      const currentValue = currentPrice * sharesNum;
      const costBasis = avgPrice * sharesNum;
      return {
        id: pos.id,
        symbol: pos.symbol,
        name: pos.name,
        type: pos.type,
        shares: sharesNum,
        avgPriceUsd: avgPrice,
        currentPriceUsd: currentPrice,
        currentValueUsd: currentValue,
        gainLossUsd: currentValue - costBasis,
        gainLossPct: costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : 0,
        icon: market?.icon ?? "📈",
        description: market?.description ?? "",
        change24h: market?.change24h ?? 0,
      };
    });

    const totalValueUsd = portfolio.reduce((sum, p) => sum + p.currentValueUsd, 0);

    return NextResponse.json({ portfolio, totalValueUsd });
  } catch {
    return NextResponse.json({ portfolio: [], totalValueUsd: 0 });
  }
}

export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { symbol, shares, avgPriceUsd } = body as {
    symbol?: string;
    shares?: string;
    avgPriceUsd?: string;
  };

  if (!symbol || !shares || !avgPriceUsd) {
    return NextResponse.json(
      { error: "Missing required fields: symbol, shares, avgPriceUsd" },
      { status: 400 }
    );
  }

  const sym = symbol.toUpperCase();
  const market = ASSET_MAP[sym];
  if (!market) {
    return NextResponse.json(
      { error: `Unknown symbol: ${sym}. Available: ${Object.keys(ASSET_MAP).join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const [investment] = await db
      .insert(investments)
      .values({
        userId,
        symbol: sym,
        name: market.name,
        type: market.type,
        shares,
        avgPriceUsd,
      })
      .returning();

    return NextResponse.json({ investment }, { status: 201 });
  } catch (err) {
    console.error("[Investments] Insert error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
