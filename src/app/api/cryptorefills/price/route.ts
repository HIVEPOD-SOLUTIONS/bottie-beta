import { NextResponse } from "next/server";
import { quotePrice, describeCryptorefillsError } from "@/lib/cryptorefills";

/**
 * GET /api/cryptorefills/price?productId=…&country=us&brand=Amazon.com&value=25
 * USDC quote for a range product (the catalogue only says "variable" for those).
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const productId = params.get("productId") ?? "";
  const country = params.get("country") ?? "";
  const brand = params.get("brand")?.trim() ?? "";
  const valueRaw = params.get("value");
  const value = valueRaw === null ? undefined : Number(valueRaw);
  if (!productId || !/^[a-zA-Z]{2}$/.test(country) || !brand || (value !== undefined && !(value > 0))) {
    return NextResponse.json({ error: "productId, country, brand and a positive value are required" }, { status: 400 });
  }
  try {
    const quote = await quotePrice({ productId, countryCode: country, brandName: brand, productValue: value });
    return NextResponse.json({ quote }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cryptorefills/price]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: describeCryptorefillsError(err) }, { status: 502 });
  }
}
