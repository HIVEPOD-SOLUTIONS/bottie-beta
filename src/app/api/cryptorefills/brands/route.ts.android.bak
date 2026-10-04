import { NextResponse } from "next/server";
import { listBrands, describeCryptorefillsError } from "@/lib/cryptorefills";

/** GET /api/cryptorefills/brands?country=us — brands sold in a country (free, cached upstream call). */
export async function GET(req: Request) {
  const country = new URL(req.url).searchParams.get("country") ?? "";
  if (!/^[a-zA-Z]{2}$/.test(country)) {
    return NextResponse.json({ error: "country must be a 2-letter ISO code" }, { status: 400 });
  }
  try {
    const brands = await listBrands(country);
    return NextResponse.json({ brands }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (err) {
    console.error("[cryptorefills/brands]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeCryptorefillsError(err) }, { status: 502 });
  }
}
