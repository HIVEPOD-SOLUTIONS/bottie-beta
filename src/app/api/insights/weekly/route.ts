/**
 * GET  /api/insights/weekly        — return the latest weekly insight for the authed user
 * POST /api/insights/weekly        — generate (or regenerate) this week's insight with Gemini Flash
 *
 * The POST is idempotent: it upserts on (userId, weekStart) so calling it multiple
 * times in the same week just refreshes the summary.
 *
 * Designed to be called:
 *   • Automatically on Monday morning via a Cloud Tasks / Vercel Cron trigger
 *   • Manually from the History tab ("Refresh insights" button)
 *   • On first visit to the History tab when no insight exists for the current week
 */

import { NextResponse } from "next/server";
import { eq, desc, gte, and } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { payments, balanceSnapshots, weeklyInsights } from "@/lib/db/schema";
import { geminiGenerateText } from "@/lib/gemini";
import { checkInsightsLimit } from "@/lib/user-rate-limiter";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** ISO date string (YYYY-MM-DD) of the most recent Monday at or before `date`. */
function getMondayOf(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon…6=Sat
  const diff = day === 0 ? -6 : 1 - day; // days back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** Return the Date 7 days before the given Date. */
function sevenDaysAgo(from: Date): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

// ── GET — latest insight ──────────────────────────────────────────────────────

export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  try {
    const [insight] = await db
      .select()
      .from(weeklyInsights)
      .where(eq(weeklyInsights.userId, userId))
      .orderBy(desc(weeklyInsights.createdAt))
      .limit(1);

    return NextResponse.json({ insight: insight ?? null });
  } catch {
    return NextResponse.json({ insight: null });
  }
}

// ── POST — generate / refresh this week's insight ────────────────────────────

export async function POST() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  // Per-user rate limit — each POST hits Gemini with a large DB-backed prompt.
  const rateLimit = checkInsightsLimit(userId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: rateLimit.reason },
      { status: 429, headers: rateLimit.headers },
    );
  }

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return NextResponse.json({ error: "GOOGLE_GENERATIVE_AI_API_KEY not configured" }, { status: 503 });
  }

  const now = new Date();
  const weekStart = getMondayOf(now);
  const since = sevenDaysAgo(now);

  try {
    // ── Fetch last 7 days of payments ────────────────────────────────────────
    const recentPayments = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.userId, userId),
          gte(payments.createdAt, since),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(100);

    // ── Fetch balance snapshots: oldest + newest in the window ───────────────
    const snapshots = await db
      .select()
      .from(balanceSnapshots)
      .where(
        and(
          eq(balanceSnapshots.userId, userId),
          gte(balanceSnapshots.createdAt, since),
        ),
      )
      .orderBy(desc(balanceSnapshots.createdAt))
      .limit(100);

    // Need at least some data to generate a meaningful insight
    if (recentPayments.length === 0 && snapshots.length === 0) {
      return NextResponse.json(
        { error: "Not enough activity yet to generate an insight" },
        { status: 422 },
      );
    }

    // ── Compute summary stats for context ────────────────────────────────────
    const totalSpent = recentPayments
      .filter((p) => p.status !== "failed")
      .reduce((s, p) => s + parseFloat(p.amountUsdc ?? "0"), 0);

    // Category with the most spend
    const spendByCategory: Record<string, number> = {};
    for (const p of recentPayments.filter((p) => p.status !== "failed")) {
      spendByCategory[p.type] = (spendByCategory[p.type] ?? 0) + parseFloat(p.amountUsdc ?? "0");
    }
    const topCategory =
      Object.entries(spendByCategory).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // Balance delta: newest snapshot total − oldest snapshot total
    const newestSnap = snapshots[0];
    const oldestSnap = snapshots[snapshots.length - 1];
    const balanceDelta =
      newestSnap && oldestSnap
        ? parseFloat(newestSnap.totalUsdc ?? "0") -
          parseFloat(oldestSnap.totalUsdc ?? "0")
        : 0;

    // ── Build Gemini prompt ───────────────────────────────────────────────────
    const paymentsForPrompt = recentPayments.slice(0, 30).map((p) => ({
      type: p.type,
      description: p.description,
      amount: `$${parseFloat(p.amountUsdc ?? "0").toFixed(2)}`,
      status: p.status,
    }));

    const contextJson = JSON.stringify({
      period: `${since.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}`,
      totalSpentUsd: totalSpent.toFixed(2),
      topCategory,
      balanceDeltaUsd: balanceDelta.toFixed(2),
      transactionCount: recentPayments.length,
      transactions: paymentsForPrompt,
    });

    const summary = await geminiGenerateText({
      system:
        "You are a concise personal finance assistant for a crypto/stablecoin payments app. " +
        "Write exactly 3 short sentences: (1) what the user spent most on this week and how much, " +
        "(2) whether their wallet balance is trending up or down and by how much, " +
        "(3) one specific, actionable money tip based on their actual spending pattern. " +
        "Be warm and direct. No jargon. No emojis. No markdown. No lists. Plain prose only. " +
        "Say 'USD' not 'USDC'. Under 80 words total.",
      prompt: contextJson,
    });

    // ── Upsert the insight ────────────────────────────────────────────────────
    const [insight] = await db
      .insert(weeklyInsights)
      .values({
        userId,
        weekStart,
        summary,
        totalSpentUsd: totalSpent.toFixed(2),
        topCategory,
        balanceDeltaUsd: balanceDelta.toFixed(2),
      })
      .onConflictDoUpdate({
        target: [weeklyInsights.userId, weeklyInsights.weekStart],
        set: {
          summary,
          totalSpentUsd: totalSpent.toFixed(2),
          topCategory,
          balanceDeltaUsd: balanceDelta.toFixed(2),
          updatedAt: new Date(),
        },
      })
      .returning();

    return NextResponse.json({ insight }, { status: 201 });
  } catch (err: any) {
    console.error("[insights/weekly] error:", err);
    return NextResponse.json(
      { error: err?.message ?? "Failed to generate insight" },
      { status: 500 },
    );
  }
}
