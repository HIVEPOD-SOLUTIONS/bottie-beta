import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { audit } from "@/lib/admin";
import { isNetworkAdmin, reviewListing } from "@/lib/provider-network";
import { isMissingTable } from "@/lib/shar";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/network/providers/:id/review  { action: "verify" | "reject" | "request_info" | "pause" | "feature" | "unfeature", note?: string }
 * "request_info" keeps the listing in the queue and shows the owner a question (the note is required).
 * Team only: the Privy user ids listed in NETWORK_ADMIN_USER_IDS. Verified providers are the ones people can use and share.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  if (!isNetworkAdmin(userId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await reviewListing(id, body?.action, body?.note);
    await audit(userId, result.ok ? `listing.${String(body?.action)}` : "listing.review.refused", "listing", id, typeof body?.note === "string" ? body.note : undefined);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.listing);
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "The provider network is being set up." }, { status: 503 });
    console.error("[network/review]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't update the listing." }, { status: 500 });
  }
}
