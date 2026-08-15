/**
 * GET  /api/bitrefill/orders?limit=N   — list the user's Bitrefill order history
 * POST /api/bitrefill/orders            — create or update a Bitrefill order record
 *   Body for create:  { invoiceId, productId, productName?, packageValue, paymentMethod,
 *                       isAddressBased, paymentAddress?, paymentAmount?, paymentCurrency?,
 *                       amountUsdc?, recipientEmail?, chain? }
 *   Body for update:  { invoiceId, status, redemptionCode?, esimInstallLink? }
 */

import { NextResponse } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bitrefillOrders } from "@/lib/db/schema";

export async function GET(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 200);
  const status = searchParams.get("status"); // optional filter

  try {
    const rows = await db
      .select()
      .from(bitrefillOrders)
      .where(
        status
          ? and(eq(bitrefillOrders.userId, userId), eq(bitrefillOrders.status, status))
          : eq(bitrefillOrders.userId, userId),
      )
      .orderBy(desc(bitrefillOrders.createdAt))
      .limit(limit);

    return NextResponse.json({ orders: rows });
  } catch {
    return NextResponse.json({ orders: [] });
  }
}

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { invoiceId, status: newStatus, redemptionCode, esimInstallLink } = body as {
    invoiceId?: string;
    status?: string;
    redemptionCode?: string;
    esimInstallLink?: string;
  };

  if (!invoiceId) {
    return NextResponse.json({ error: "invoiceId is required" }, { status: 400 });
  }

  try {
    // ── Update path — when only status/code fields are present ─────────────────
    if (newStatus && Object.keys(body).every((k) =>
      ["invoiceId", "status", "redemptionCode", "esimInstallLink"].includes(k)
    )) {
      const [updated] = await db
        .update(bitrefillOrders)
        .set({
          status: newStatus,
          ...(redemptionCode !== undefined && { redemptionCode }),
          ...(esimInstallLink !== undefined && { esimInstallLink }),
          updatedAt: new Date(),
        })
        .where(and(eq(bitrefillOrders.invoiceId, invoiceId), eq(bitrefillOrders.userId, userId)))
        .returning();

      return NextResponse.json({ order: updated });
    }

    // ── Create path — upsert on invoiceId ──────────────────────────────────────
    const {
      productId, productName, packageValue, paymentMethod,
      isAddressBased, paymentAddress, paymentAmount, paymentCurrency,
      amountUsdc, recipientEmail, chain,
    } = body as {
      productId?: string;
      productName?: string;
      packageValue?: string;
      paymentMethod?: string;
      isAddressBased?: boolean;
      paymentAddress?: string;
      paymentAmount?: string | number;
      paymentCurrency?: string;
      amountUsdc?: string | number;
      recipientEmail?: string;
      chain?: string;
    };

    if (!productId || !packageValue || !paymentMethod) {
      return NextResponse.json(
        { error: "productId, packageValue, and paymentMethod are required" },
        { status: 400 },
      );
    }

    const [order] = await db
      .insert(bitrefillOrders)
      .values({
        userId,
        invoiceId,
        productId,
        productName: productName ?? null,
        packageValue,
        paymentMethod,
        isAddressBased: Boolean(isAddressBased),
        paymentAddress: paymentAddress ?? null,
        paymentAmount: paymentAmount != null ? String(paymentAmount) : null,
        paymentCurrency: paymentCurrency ?? null,
        amountUsdc: amountUsdc != null ? String(amountUsdc) : null,
        recipientEmail: recipientEmail ?? null,
        chain: chain ?? null,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: [bitrefillOrders.invoiceId],
        set: {
          status: "pending",
          updatedAt: new Date(),
        },
      })
      .returning();

    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    console.error("[bitrefill/orders] error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
