import { NextRequest, NextResponse } from "next/server";
import { mcpGetInvoice } from "@/lib/bitrefill-mcp";
import { verifyAuth } from "@/lib/auth";

/**
 * GET /api/bitrefill/invoice/[id]
 *
 * Poll invoice status via the Bitrefill MCP API (OAuth client_credentials).
 * Returns the invoice with a convenience top-level `code` field on completion.
 * Poll every 4 seconds after sending payment until status === "complete".
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
  // The invoice_access_token is needed for polling — Bitrefill includes it in the
  // buy-products response and requires it in get-invoice-by-id calls.
  const accessToken = req.nextUrl.searchParams.get("token") ?? undefined;

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
