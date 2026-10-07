import { NextResponse } from "next/server";
import { callProvider, checkCallInput, getListing, getTerms } from "@/lib/provider-network";
import { agentAccepts, TERMS } from "@/lib/provider-terms-rules";
import { NETWORK } from "@/lib/provider-network-rules";
import { hit } from "@/lib/rate-limit-store";
import { isMissingTable } from "@/lib/shar";
import { getServerEnv } from "@/lib/server-env";
import { handleX402Call, httpFacilitator } from "@/lib/x402-edge";
import { loadX402Config } from "@/lib/x402-rules";

export const maxDuration = 60; // verify (10s) + the provider (10s) + settle (30s)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/network/providers/:id/x402  — call a PAID provider with a wallet, no Bluvfi account (the x402 protocol, v2).
 *
 *   1. POST with no payment            -> 402 and a PAYMENT-REQUIRED header saying what to pay (USDC on Solana).
 *   2. POST again with PAYMENT-SIGNATURE -> we verify the payment, call the provider, settle, and return its answer with a
 *      PAYMENT-RESPONSE header. If the provider fails, nothing is settled and the agent isn't charged.
 *
 * Public on purpose (agents have no account), so it is rate limited per IP, only answers for verified paid listings, and only
 * runs the provider after a payment verifies. Off (503) until X402_FACILITATOR_URL and a pay-to address are configured.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const limit = await hit(`x402:${ip}`, 60_000, 30);
  if (!limit.allowed) return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429, headers: { "Retry-After": "60" } });

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

    // A request that doesn't fit the provider's listed inputs is refused before any payment is asked for or verified.
    const input = await checkCallInput(listing.id, payload);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

    // The owner's own terms: an agent has no account to click a box in, so it accepts by sending the hash it was shown. Before any payment.
    const ownerTerms = (await getTerms([listing.id])).get(listing.id);
    if (ownerTerms && !agentAccepts(req.headers.get(TERMS.agentHeader), ownerTerms.hash)) {
      return NextResponse.json(
        {
          error: "terms_required",
          message: "This provider has its own terms. Read them, then repeat the request with the header X-Bluvfi-Terms set to the hash below to accept them. Nothing has been charged.",
          terms: { text: ownerTerms.text, url: ownerTerms.url, hash: ownerTerms.hash },
          header: TERMS.agentHeader,
        },
        { status: 428, headers: { "Cache-Control": "no-store" } },
      );
    }

    const config = loadX402Config(getServerEnv);
    const result = await handleX402Call(
      {
        listing,
        url: new URL(req.url).origin + new URL(req.url).pathname,
        paymentHeader: req.headers.get("payment-signature") ?? req.headers.get("x-payment"),
        payload: input.payload,
      },
      { config, facilitator: config ? httpFacilitator(config) : { feePayer: async () => null, verify: async () => ({ kind: "error" }), settle: async () => ({ kind: "unknown" }) }, callProvider },
    );
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "The provider network is being set up." }, { status: 503 });
    console.error("[network/x402]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't complete that call." }, { status: 500 });
  }
}
