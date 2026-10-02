import { NextRequest, NextResponse } from "next/server";
import { mcpGetProductDetails } from "@/lib/bitrefill-mcp";

/**
 * GET /api/bitrefill/products/[id]
 *
 * Fetches full product details via the Bitrefill MCP API (OAuth client_credentials).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const product = await mcpGetProductDetails(id);
    return NextResponse.json(product);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Product fetch failed";
    console.error("[/api/bitrefill/products/[id]]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
