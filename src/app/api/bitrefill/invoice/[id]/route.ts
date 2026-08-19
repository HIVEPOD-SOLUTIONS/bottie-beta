import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { mcpGetInvoice } from "@/lib/bitrefill-mcp";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bitrefillOrders } from "@/lib/db/schema";

/**
 * GET /api/bitrefill/invoice/[id]
 *
 * Check invoice status — DB-first to avoid hitting the Bitrefill rate limit.
 *
 * When a webhook has already delivered the terminal state (complete/failed/expired)
 * we serve it straight from the DB without an MCP round-trip.
 *
 * For non-terminal states (or when the webhook hasn't fired yet) we fall back to
 * the Bitrefill MCP API (get-invoice-by-id) and return the live response.
 * Poll every 10 seconds — compliant with the 60 req/10 min rate limit.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const accessToken = req.nextUrl.searchParams.get("token") ?? undefined;

  // ── 1. DB-first: if we already have a terminal status, serve it immediately ──
  try {
    const [row] = await db
      .select()
      .from(bitrefillOrders)
      .where(eq(bitrefillOrders.invoiceId, id))
      .limit(1);

    if (row && (row.status === "complete" || row.status === "failed" || row.status === "expired")) {
      return NextResponse.json({
        invoice_id:   row.invoiceId,
        status:       row.status,
        invoice_status: row.status,
        code:         row.redemptionCode ?? null,
        esim_install_link: row.esimInstallLink ?? null,
        orders:       row.redemptionCode
          ? [{ order_id: "", status: row.status, redemption_info: { redemption_available: true, code: row.redemptionCode } }]
          : row.esimInstallLink
            ? [{ order_id: "", status: row.status, esim_install_link: row.esimInstallLink }]
            : [],
        // Signal to client that this came from the DB (webhook already delivered)
        _source: "db",
      });
    }
  } catch (dbErr) {
    // DB unavailable — fall through to MCP
    console.warn("[/api/bitrefill/invoice/[id]] DB read failed, falling back to MCP", dbErr);
  }

  // ── 2. MCP fallback — invoice not yet terminal in DB ──────────────────────
  try {
    const invoice = await mcpGetInvoice(id, accessToken);

    // Extract redemption code from the first completed order
    let code: string | null = null;
    if (invoice.orders) {
      for (const order of invoice.orders) {
        const info = order.redemption_info;
        if (info) {
          code = info.pin ?? info.code ?? null;
          if (code) break;
        }
      }
    }

    return NextResponse.json({ ...invoice, code });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invoice fetch failed";
    console.error("[/api/bitrefill/invoice/[id]]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
