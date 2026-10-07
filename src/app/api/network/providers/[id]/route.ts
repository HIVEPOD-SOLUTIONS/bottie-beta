import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getProviderDetail, ownerAction, updateListing } from "@/lib/provider-network";
import { isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTING_UP = { error: "The provider network is being set up. Try again soon." };

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    /api/network/providers/:id   — one provider's page (verified ones for anyone signed in; the owner can open their own in any state)
 * PATCH  /api/network/providers/:id   — the owner edits it ({ name?, summary?, category?, endpointUrl?, docsUrl?, priceUsdc?, payoutWallet?,
 *                                       exampleRequest?, inputFields?, requirements?, setupUrl?, teamNotes?, auth?, operatorType?,
 *                                       companyName?, companyWebsite?, contactEmail? }) or pauses / resumes it ({ action: "pause" | "resume" })
 * DELETE /api/network/providers/:id   — the owner removes it (hidden everywhere; usage and earnings history are kept)
 *
 * Changing what people see or what gets called sends a live listing back to the team to look at again.
 */
export async function GET(_req: Request, { params }: Ctx) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "network-detail", 60, 2000);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  try {
    const provider = await getProviderDetail(id, userId);
    if (!provider) return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    return NextResponse.json({ provider }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json(SETTING_UP, { status: 503 });
    console.error("[network/provider]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load that provider." }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "network-manage", 20, 100);
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
    if (body && typeof body === "object" && "action" in body) {
      const action = (body as Record<string, unknown>).action;
      if (action !== "pause" && action !== "resume") return NextResponse.json({ error: "action must be pause or resume" }, { status: 400 });
      const res = await ownerAction(userId, id, action);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
      return NextResponse.json({ provider: res.listing });
    }
    const res = await updateListing(userId, id, body);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ provider: res.listing, sentForReview: res.sentForReview, wasLive: res.wasLive });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json(SETTING_UP, { status: 503 });
    console.error("[network/provider:patch]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save the changes." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "network-manage", 20, 100);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  try {
    const res = await ownerAction(userId, id, "delete");
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json(SETTING_UP, { status: 503 });
    console.error("[network/provider:delete]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't remove that provider." }, { status: 500 });
  }
}
