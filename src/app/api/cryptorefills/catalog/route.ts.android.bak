import { NextResponse } from "next/server";
import { listCatalog, describeCryptorefillsError } from "@/lib/cryptorefills";

/** GET /api/cryptorefills/catalog?country=us&brand=Netflix — denominations and indicative USDC prices. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const country = params.get("country") ?? "";
  const brand = params.get("brand")?.trim() ?? "";
  if (!/^[a-zA-Z]{2}$/.test(country) || !brand || brand.length > 120) {
    return NextResponse.json({ error: "country (2-letter code) and brand are required" }, { status: 400 });
  }
  try {
    const items = await listCatalog(country, brand);
    return NextResponse.json({ items }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (err) {
    console.error("[cryptorefills/catalog]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeCryptorefillsError(err) }, { status: 502 });
  }
}
