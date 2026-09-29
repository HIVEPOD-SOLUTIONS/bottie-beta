import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { getPartnerOrder, describeCryptorefillsError } from "@/lib/cryptorefills";

/**
 * GET /api/cryptorefills/partner-orders/[id] — status of a deposit-address order,
 * and the code once delivered. Owner-only (checked against the payments row).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  const { id } = await params;
  const [row] = await db
    .select({ id: payments.id, status: payments.status })
    .from(payments)
    .where(and(eq(payments.userId, userId), eq(payments.referenceId, id)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  try {
    const order = await getPartnerOrder(id);
    const next = order.status === "completed" ? "completed" : order.status === "failed" || order.status === "expired" ? "failed" : null;
    if (next && next !== row.status) await db.update(payments).set({ status: next }).where(eq(payments.id, row.id));
    return NextResponse.json({ order }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cryptorefills/partner-orders/:id]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeCryptorefillsError(err) }, { status: 502 });
  }
}
