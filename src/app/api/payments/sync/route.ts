import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { payments, bitrefillOrders } from "@/lib/db/schema";
import { mcpGetInvoice } from "@/lib/bitrefill-mcp";

/**
 * POST /api/payments/sync
 * Check Bitrefill invoice status for every pending bill payment and update the DB.
 *
 * Status mapping:
 *   complete                           → completed
 *   failed | expired | cancelled       → failed
 *   unpaid (> 5 min old)               → failed  (no payment received; user abandoned)
 *   payment_detected | payment_confirmed | pending → leave as pending (payment in flight)
 */
export async function POST() {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Find all pending bill payments for this user
    const pendingRows = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.userId, userId),
          eq(payments.type, "bill"),
          eq(payments.status, "pending"),
        ),
      );

    if (pendingRows.length === 0) {
      return NextResponse.json({ updated: 0 });
    }

    const now = Date.now();
    const STALE_MS = 5 * 60 * 1_000; // 5 minutes

    const toCheck = pendingRows.filter((p) => p.referenceId).slice(0, 10);

    const results = await Promise.allSettled(
      toCheck.map(async (p) => {
        try {
          const invoice = await mcpGetInvoice(p.referenceId!);
          const ageMs = p.createdAt ? now - new Date(p.createdAt).getTime() : 0;

          // Determine the new status
          const newStatus =
            invoice.status === "complete"
              ? "completed"
              : invoice.status === "failed" ||
                invoice.status === "expired" ||
                invoice.status === "cancelled"
              ? "failed"
              : invoice.status === "unpaid" && ageMs > STALE_MS
              ? "failed" // No payment received in over 5 min → abandoned
              : null; // payment_detected / payment_confirmed / pending / fresh unpaid → leave

          if (newStatus) {
            await db
              .update(payments)
              .set({ status: newStatus })
              .where(
                and(
                  eq(payments.userId, userId),
                  eq(payments.referenceId, p.referenceId!),
                ),
              );

            await db
              .update(bitrefillOrders)
              .set({
                status: invoice.status === "complete" ? "complete" : newStatus,
                updatedAt: new Date(),
              })
              .where(eq(bitrefillOrders.invoiceId, p.referenceId!))
              .catch(() => {});

            return { invoiceId: p.referenceId, from: "pending", to: newStatus };
          }
          return null;
        } catch {
          // If Bitrefill is unreachable, leave the row alone
          return null;
        }
      }),
    );

    const updated = results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => (r as PromiseFulfilledResult<{ invoiceId: string | null; from: string; to: string }>).value);

    return NextResponse.json({ updated: updated.length, changes: updated });
  } catch (err) {
    console.error("[payments/sync] error:", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
