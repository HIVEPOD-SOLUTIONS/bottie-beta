import { NextResponse } from "next/server";
import { listPaymentMethods, partnerConfigured, describeCryptorefillsError } from "@/lib/cryptorefills";

/**
 * GET /api/cryptorefills/payment-methods
 * Coins/networks for "pay with other crypto" (partner API, deposit address).
 * `partnerEnabled` is false until CRYPTOREFILLS_PARTNER_ID is set — the UI then
 * offers only the gasless USDC rails.
 */
export async function GET() {
  if (!partnerConfigured()) return NextResponse.json({ partnerEnabled: false, methods: [] });
  try {
    const methods = await listPaymentMethods();
    return NextResponse.json({ partnerEnabled: true, methods }, { headers: { "Cache-Control": "public, max-age=300" } });
  } catch (err) {
    console.error("[cryptorefills/payment-methods]", err instanceof Error ? err.message : err);
    return NextResponse.json({ partnerEnabled: false, methods: [], error: describeCryptorefillsError(err) });
  }
}
