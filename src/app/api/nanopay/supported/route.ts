/**
 * GET /api/nanopay/supported
 * Query which x402 payment schemes the Circle facilitator currently accepts.
 * Useful for diagnostics — confirms the facilitator is reachable and shows
 * supported scheme versions before attempting a payment.
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { getFacilitatorClient } from "@/lib/circle-gateway";

export async function GET() {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  try {
    const facilitator = getFacilitatorClient();
    const supported = await facilitator.getSupported();
    return NextResponse.json(supported);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed to fetch supported schemes" }, { status: 500 });
  }
}
