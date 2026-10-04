import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { goals } from "@/lib/db/schema";

export async function GET() {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userGoals = await db
      .select()
      .from(goals)
      .where(eq(goals.userId, userId));
    return NextResponse.json({ goals: userGoals });
  } catch {
    return NextResponse.json({ goals: [] });
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

  try {
    const { vaultId, name, targetAmount, currency } = body as {
      vaultId?: string;
      name?: string;
      targetAmount?: string;
      currency?: string;
    };

    if (!vaultId || !name || !targetAmount || !currency) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const [goal] = await db
      .insert(goals)
      .values({ userId, vaultId, name, targetAmount, currency })
      .onConflictDoUpdate({
        target: [goals.userId, goals.vaultId],
        set: { name, targetAmount, currency, updatedAt: new Date() },
      })
      .returning();

    return NextResponse.json({ goal });
  } catch {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const vaultId = searchParams.get("vaultId");

    if (!vaultId) {
      return NextResponse.json(
        { error: "Missing vaultId" },
        { status: 400 },
      );
    }

    await db
      .delete(goals)
      .where(and(eq(goals.userId, userId), eq(goals.vaultId, vaultId)));

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
