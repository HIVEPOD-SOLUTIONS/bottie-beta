/**
 * Server-side completion of Bitrefill orders.
 *
 * An order used to be marked complete only by Bitrefill's webhook (which can't
 * reach localhost, and may be delayed) or by the checkout screen still being
 * open when Bitrefill finished. An order paid with Arc / Tempo / Zcash / … via
 * bluvfi-xrpl, or any order whose tab was closed, could stay "pending" forever
 * even though the purchase went through.
 *
 * syncBitrefillOrder() asks Bitrefill directly (with the invoice's stored
 * access token) and writes the outcome to bitrefill_orders and payments. It is
 * called when a chain swap completes, from the invoice status route, and when
 * the dashboard lists payments — so orders correct themselves.
 */

import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bitrefillOrders, payments } from "@/lib/db/schema";
import { mcpGetInvoice } from "@/lib/bitrefill-mcp";
import { isXrplBackendConfigured, reportServiceConfirmation } from "@/lib/xrplBackend";

type Invoice = Awaited<ReturnType<typeof mcpGetInvoice>>;
export type SyncedStatus = "complete" | "failed" | "expired" | "pending" | "unknown";

function extractCode(invoice: Invoice): { code: string | null; esim: string | null } {
  for (const order of invoice.orders ?? []) {
    const info = order.redemption_info;
    const code = info?.pin ?? info?.code ?? null;
    const esim = (order as { esim_install_link?: string }).esim_install_link ?? null;
    if (code || esim) return { code: code ? String(code) : null, esim };
  }
  return { code: null, esim: null };
}

/** Writes a terminal Bitrefill status to both tables (no-op if already terminal). Exported for the invoice route. */
export async function applyBitrefillOutcome(invoiceId: string, invoice: Invoice): Promise<SyncedStatus> {
  const status = invoice.status;
  if (status === "complete") {
    const { code, esim } = extractCode(invoice);
    const [order] = await db.update(bitrefillOrders)
      .set({ status: "complete", ...(code ? { redemptionCode: code } : {}), ...(esim ? { esimInstallLink: esim } : {}), updatedAt: new Date() })
      .where(and(eq(bitrefillOrders.invoiceId, invoiceId), inArray(bitrefillOrders.status, ["pending", "expired", "failed"])))
      .returning({ walletRequestId: bitrefillOrders.xrplWalletRequestId });
    await db.update(payments).set({ status: "completed" })
      .where(and(eq(payments.referenceId, invoiceId), eq(payments.type, "bill")))
      .catch(() => {});
    // Same confirmation Bitrefill's webhook would send, so bluvfi-xrpl closes the swap as delivered.
    if (order?.walletRequestId && isXrplBackendConfigured()) {
      await reportServiceConfirmation(order.walletRequestId, "CONFIRMED", { invoiceId, source: "bluvfi-sync" })
        .catch((e: unknown) => console.warn("[bitrefill-sync] service confirmation failed", e instanceof Error ? e.message : e));
    }
    return "complete";
  }
  if (status === "failed" || status === "expired") {
    await db.update(bitrefillOrders).set({ status, updatedAt: new Date() })
      .where(and(eq(bitrefillOrders.invoiceId, invoiceId), eq(bitrefillOrders.status, "pending")))
      .catch(() => {});
    await db.update(payments).set({ status: "failed" })
      .where(and(eq(payments.referenceId, invoiceId), eq(payments.type, "bill"), eq(payments.status, "pending")))
      .catch(() => {});
    return status;
  }
  return "pending";
}

/** Asks Bitrefill for one order's status and records it. Never throws. */
export async function syncBitrefillOrder(invoiceId: string): Promise<SyncedStatus> {
  try {
    const [row] = await db.select({ status: bitrefillOrders.status, token: bitrefillOrders.invoiceAccessToken })
      .from(bitrefillOrders).where(eq(bitrefillOrders.invoiceId, invoiceId)).limit(1);
    if (!row) return "unknown";
    if (row.status === "complete") return "complete";
    const invoice = await mcpGetInvoice(invoiceId, row.token ?? undefined);
    return await applyBitrefillOutcome(invoiceId, invoice);
  } catch (err) {
    // "Invoice not found" without a token, Bitrefill down, rate limit… try again later.
    console.warn(`[bitrefill-sync] ${invoiceId}:`, err instanceof Error ? err.message : err);
    return "unknown";
  }
}

/**
 * Re-checks this user's recent pending Bitrefill orders that Bitrefill can be
 * asked about (an access token is stored). Bounded so a dashboard load stays
 * cheap and within Bitrefill's rate limit.
 */
export async function syncPendingBitrefillOrders(userId: string, max = 4): Promise<number> {
  const since = new Date(Date.now() - 3 * 86_400_000);
  const rows = await db.select({ invoiceId: bitrefillOrders.invoiceId, token: bitrefillOrders.invoiceAccessToken })
    .from(bitrefillOrders)
    .where(and(eq(bitrefillOrders.userId, userId), eq(bitrefillOrders.status, "pending"), gt(bitrefillOrders.createdAt, since)))
    .limit(10)
    .catch(() => []);
  const askable = rows.filter((r) => r.token).slice(0, max);
  const results = await Promise.all(askable.map((r) => syncBitrefillOrder(r.invoiceId)));
  return results.filter((s) => s === "complete" || s === "failed" || s === "expired").length;
}
