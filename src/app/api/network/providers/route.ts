import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { createListing, listMine, listVerified } from "@/lib/provider-network";
import { isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

const SETTING_UP = { error: "The provider network is being set up. Try again soon." };

/**
 * GET  /api/network/providers          — verified providers anyone can use (no endpoint URLs; calls go through the gateway)
 * GET  /api/network/providers?mine=1   — the caller's own listings in every state, with what each has earned
 * POST /api/network/providers          — add a provider (or remix one with remixOfId); starts as "submitted" until verified
 */
export async function GET(req: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "network-list", 60, 2000);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  try {
    const mine = req.nextUrl.searchParams.get("mine") === "1";
    const providers = mine ? await listMine(userId) : await listVerified(userId);
    return NextResponse.json({ providers }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ providers: [], ready: false });
    console.error("[network/providers]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load providers right now." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "network-submit", 5, 20);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await createListing(userId, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const l = result.listing;
    return NextResponse.json({ provider: { id: l.id, name: l.name, slug: l.slug, status: l.status } }, { status: 201 });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json(SETTING_UP, { status: 503 });
    console.error("[network/providers]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save the provider." }, { status: 500 });
  }
}
