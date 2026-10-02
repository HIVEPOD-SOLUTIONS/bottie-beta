import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bills } from "@/lib/db/schema";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { status, autopay, amount, dueDate } = body as {
    status?: string;
    autopay?: boolean;
    amount?: string;
    dueDate?: string;
  };

  const validStatuses = ["pending", "paid", "overdue"];
  if (status && !validStatuses.includes(status)) {
    return NextResponse.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    // Verify ownership
    const existing = await db
      .select()
      .from(bills)
      .where(and(eq(bills.id, id), eq(bills.userId, userId)));

    if (existing.length === 0) {
      return NextResponse.json({ error: "Bill not found" }, { status: 404 });
    }

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (status !== undefined) updateFields.status = status;
    if (autopay !== undefined) updateFields.autopay = autopay;
    if (amount !== undefined) updateFields.amount = amount;
    if (dueDate !== undefined) updateFields.dueDate = dueDate;

    const [updated] = await db
      .update(bills)
      .set(updateFields)
      .where(and(eq(bills.id, id), eq(bills.userId, userId)))
      .returning();

    return NextResponse.json({ bill: updated });
  } catch (err) {
    console.error("[Bills PATCH] Error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const existing = await db
      .select()
      .from(bills)
      .where(and(eq(bills.id, id), eq(bills.userId, userId)));

    if (existing.length === 0) {
      return NextResponse.json({ error: "Bill not found" }, { status: 404 });
    }

    await db.delete(bills).where(and(eq(bills.id, id), eq(bills.userId, userId)));

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[Bills DELETE] Error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
