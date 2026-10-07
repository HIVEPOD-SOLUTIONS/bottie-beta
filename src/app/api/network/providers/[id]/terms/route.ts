import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { acceptTerms } from "@/lib/provider-network";
import { isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/network/providers/:id/terms  { hash }
 * Records that the caller agreed to the owner's CURRENT terms for this provider (the hash comes from the provider's page and must match,
 * so nobody can agree to terms they weren't shown). Calls to the provider are refused until this is done, and again whenever the terms change.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "network-terms", 30, 300);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const res = await acceptTerms(userId, id, body?.hash);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ accepted: true, acceptedAt: res.acceptedAt }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "The provider network is being set up. Try again soon." }, { status: 503 });
    console.error("[network/terms]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }
}
