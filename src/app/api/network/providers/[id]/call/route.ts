import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { noteDevice } from "@/lib/abuse";
import { getListing, runProviderCall } from "@/lib/provider-network";
import { NETWORK } from "@/lib/provider-network-rules";
import { isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

export const maxDuration = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/network/providers/:id/call  — send a JSON request to a verified provider and get its answer back.
 *
 * The gateway is what makes use measurable: each successful call is recorded, and the owner earns Shar for it (with caps, see
 * recordUsage). Only verified providers can be called.
 *
 * Paid providers: the price is taken from the caller's prepaid credits (/api/credits) before the call and given back if the
 * provider fails, so nobody is charged for an error. On success the owner earns 80% as commission. With too few credits the
 * answer is 402 { code: "insufficient_credits", requiredMicro, balanceMicro }.
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
  await noteDevice(req, userId);

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
    const outcome = await runProviderCall(listing, userId, payload);
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error, code: outcome.code, requiredMicro: outcome.requiredMicro, balanceMicro: outcome.balanceMicro },
        { status: outcome.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { providerStatus: outcome.providerStatus, data: outcome.data, chargedMicro: outcome.chargedMicro, balanceMicro: outcome.balanceMicro },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "The provider network is being set up." }, { status: 503 });
    console.error("[network/call]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't call the provider." }, { status: 500 });
  }
}
