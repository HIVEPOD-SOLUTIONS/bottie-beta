import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { getOrder, describeCryptorefillsError } from "@/lib/cryptorefills";

/**
 * GET /api/cryptorefills/orders/[id] — order status and, once delivered, the voucher.
 *
 * Cryptorefills' own status endpoint needs only the order id, so we check the
 * caller owns the order (via the payments row written at checkout) before
 * returning cash-like voucher codes. Also flips that row to completed/failed.
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
    const order = await getOrder(id);
    const next = order.status === "completed" ? "completed" : order.status === "failed" || order.status === "expired" ? "failed" : null;
    if (next && next !== row.status) {
      await db.update(payments).set({ status: next }).where(eq(payments.id, row.id));
    }
    return NextResponse.json({ order }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cryptorefills/orders/:id]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeCryptorefillsError(err) }, { status: 502 });
  }
}
