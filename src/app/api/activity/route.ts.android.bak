import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";

export async function GET(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Number(searchParams.get("limit")) || 20, 100);

    const userActivities = await db
      .select()
      .from(activities)
      .where(eq(activities.userId, userId))
      .orderBy(desc(activities.createdAt))
      .limit(limit);

    return NextResponse.json({ activities: userActivities });
  } catch {
    return NextResponse.json({ activities: [] });
  }
}

const VALID_ACTIVITY_TYPES = new Set(["deposit", "withdraw", "swap", "swap_and_deposit"]);

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

  const { type, amount, tokenSymbol, vaultId, txHash } = body as {
    type?: string;
    amount?: string;
    tokenSymbol?: string;
    vaultId?: string;
    txHash?: string;
  };

  if (!type || !amount || !tokenSymbol) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  if (!VALID_ACTIVITY_TYPES.has(type)) {
    return NextResponse.json(
      { error: "Invalid activity type" },
      { status: 400 },
    );
  }

  try {
    const [activity] = await db
      .insert(activities)
      .values({ userId, type, amount, tokenSymbol, vaultId, txHash })
      .returning();

    return NextResponse.json({ activity });
  } catch (err) {
    console.error("[Activity] Insert error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
