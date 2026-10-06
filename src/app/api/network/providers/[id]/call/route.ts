import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { callProvider, getListing, recordUsage } from "@/lib/provider-network";
import { NETWORK } from "@/lib/provider-network-rules";
import { isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

export const maxDuration = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/network/providers/:id/call  — send a JSON request to a verified provider and get its answer back.
 *
 * The gateway is what makes use measurable: each successful call is recorded, and the owner earns Shar for it (with caps, see
 * recordUsage). Only verified providers can be called. Paid providers need x402 settlement, which isn't enabled yet, so they
 * are refused rather than called for free.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "network-call", 20, 300);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Provider not found" }, { status: 404 });

  const text = await req.text();
  if (text.length > NETWORK.maxRequestBytes) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  let payload: unknown = {};
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  try {
    const listing = await getListing(id);
    if (!listing || listing.status !== "verified") return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    if (Number(listing.priceUsdc) > 0) {
      return NextResponse.json({ error: "Paid providers can't be called yet: x402 payments aren't enabled." }, { status: 501 });
    }
    const result = await callProvider(listing, payload);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    if (result.status >= 200 && result.status < 300) await recordUsage(listing, userId);
    return NextResponse.json({ providerStatus: result.status, data: result.body }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "The provider network is being set up." }, { status: 503 });
    console.error("[network/call]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't call the provider." }, { status: 500 });
  }
}
