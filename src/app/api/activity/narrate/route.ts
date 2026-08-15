import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { VAULT_FRIENDLY_NAMES, TOKEN_DISPLAY_NAMES } from "@/lib/constants";
import { geminiGenerateText } from "@/lib/gemini";
import { checkNarrateLimit } from "@/lib/user-rate-limiter";

export async function GET() {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Per-user rate limit — each call invokes Gemini Flash.
  const rateLimit = checkNarrateLimit(userId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: rateLimit.reason },
      { status: 429, headers: rateLimit.headers },
    );
  }

  try {
    const rows = await db
      .select()
      .from(activities)
      .where(eq(activities.userId, userId))
      .orderBy(desc(activities.createdAt))
      .limit(10);

    if (rows.length === 0) {
      return NextResponse.json({ narration: null });
    }

    const data = rows.map((r) => ({
      action: r.type,
      amount: r.amount,
      asset: TOKEN_DISPLAY_NAMES[r.tokenSymbol] || r.tokenSymbol,
      savingsAccount: r.vaultId ? (VAULT_FRIENDLY_NAMES[r.vaultId] || r.vaultId) : undefined,
      date: r.createdAt.toISOString().slice(0, 10),
    }));

    const text = await geminiGenerateText({
      system:
        "You are a concise financial narrator for a savings app. Summarize the user's recent activity in 2-3 sentences. Be warm, editorial, no DeFi jargon. Mention totals, patterns, and timeframes. Keep it under 50 words. Do not use emojis. Do not use any markdown formatting. Use simple token names: say ETH not WETH, say USD not USDC, say BTC not cbBTC. Never repeat a token name twice in a row.",
      prompt: JSON.stringify(data),
    });

    return NextResponse.json({ narration: text });
  } catch {
    return NextResponse.json({ narration: null });
  }
}
