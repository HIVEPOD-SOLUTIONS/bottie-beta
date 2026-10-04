import { NextRequest, NextResponse } from "next/server";
import { mcpSearchProducts } from "@/lib/bitrefill-mcp";

/**
 * GET /api/bitrefill/products
 *
 * Searches the Bitrefill catalog via the Bitrefill MCP API.
 * Uses the public endpoint (https://api.bitrefill.com/mcp) by default —
 * no API key required. Set BITREFILL_MCP_URL or BITREFILL_API_KEY for
 * an authenticated account.
 *
 * Query params:
 *   q        — free-text search
 *   category — e.g. "entertainment", "gaming", "topup", "esim"
 *   country  — ISO 3166-1 alpha-2, default "US"
 *   limit    — default 30
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q        = searchParams.get("q")        ?? undefined;
  const category = searchParams.get("category") ?? undefined;
  const country  = searchParams.get("country")  ?? "US";
  const limit    = Math.min(parseInt(searchParams.get("limit") ?? "30"), 100);

  try {
    const products = await mcpSearchProducts({ query: q, category, country, limit });
    return NextResponse.json({ configured: true, data: products });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "MCP error";
    console.error("[/api/bitrefill/products]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
