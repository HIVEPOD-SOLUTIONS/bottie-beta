import { NextResponse } from "next/server";
import { eq, desc, and } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

/**
 * PATCH /api/payments
 * Update status (and optionally txHash) of an existing payment by referenceId.
 * Only the authenticated user's own payments can be updated.
 *
 * Body: { referenceId: string, status: string, txHash?: string }
 */
export async function PATCH(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { referenceId, status, txHash, description, amountUsdc, chain } = body as {
    referenceId?: string;
    status?: string;
    txHash?: string;
    description?: string;
    amountUsdc?: string;
    chain?: string;
  };

  if (!referenceId || !status) {
    return NextResponse.json(
      { error: "referenceId and status are required" },
      { status: 400 },
    );
  }

  const validStatuses = ["pending", "processing", "completed", "failed"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const [updated] = await db
      .update(payments)
      .set({
        status,
        ...(txHash ? { txHash } : {}),
        ...(description ? { description } : {}),
        ...(amountUsdc ? { amountUsdc } : {}),
        ...(chain ? { chain } : {}),
      })
      .where(and(eq(payments.userId, userId), eq(payments.referenceId, referenceId)))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }
    return NextResponse.json({ payment: updated });
  } catch (err) {
    console.error("[Payments] PATCH error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}

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
    const type = searchParams.get("type"); // "bill" | "investment"

    const allPayments = await db
      .select()
      .from(payments)
      .where(
        type
          ? and(eq(payments.userId, userId), eq(payments.type, type))
          : eq(payments.userId, userId)
      )
      .orderBy(desc(payments.createdAt))
      .limit(limit);

    return NextResponse.json({ payments: allPayments });
  } catch {
    return NextResponse.json({ payments: [] });
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

  const { type, referenceId, description, amountUsdc, status, txHash, chain } =
    body as {
      type?: string;
      referenceId?: string;
      description?: string;
      amountUsdc?: string;
      status?: string;
      txHash?: string;
      /** "evm" | "solana" — which network the payment was sent on */
      chain?: string;
    };

  if (!type || !description || !amountUsdc || !status) {
    return NextResponse.json(
      { error: "Missing required fields: type, description, amountUsdc, status" },
      { status: 400 }
    );
  }

  const validTypes = ["bill", "investment", "nanopay", "solpay", "x402", "transfer", "deposit", "withdrawal", "bridge", "onramp", "offramp"];
  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { error: `Invalid type. Must be one of: ${validTypes.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const [payment] = await db
      .insert(payments)
      .values({
        userId,
        type,
        referenceId: referenceId ?? null,
        description,
        amountUsdc,
        status,
        txHash: txHash ?? null,
        ...(chain ? { chain } : {}),
      })
      .returning();

    return NextResponse.json({ payment }, { status: 201 });
  } catch (err) {
    console.error("[Payments] Insert error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
