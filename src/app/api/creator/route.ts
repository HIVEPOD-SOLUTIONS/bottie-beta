import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { enrollCreator, getCreator, updateCreator } from "@/lib/provider-network";
import { PROVIDER_TERMS_VERSION } from "@/lib/provider-publisher-rules";
import { isMissingTable } from "@/lib/shar";
import { checkApiLimit } from "@/lib/user-rate-limiter";

const SETTING_UP = { error: "Provider sign-up is being set up. Try again soon." };

async function guard() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return { error: authErrorResponse(err) } as const;
  }
  const limit = await checkApiLimit(userId, "creator", 20, 200);
  if (!limit.allowed) return { error: NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers }) } as const;
  return { userId } as const;
}

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Provider creators: becoming one is an OPT-IN sign-up. Not every account can list providers; only people who signed up here
 * (who they are, a contact email only the team sees, and agreement to Bluvfi's provider terms).
 *
 * GET   /api/creator   — { creator: null | {...}, termsVersion, termsCurrent }  (termsCurrent=false: they must agree again)
 * POST  /api/creator   — sign up (or agree again): { operatorType, companyName?, companyWebsite?, contactEmail, termsAccepted, termsVersion }
 * PATCH /api/creator   — change who you are or your contact email: { operatorType?, companyName?, companyWebsite?, contactEmail? }
 */
export async function GET() {
  const g = await guard();
  if ("error" in g) return g.error;
  try {
    const creator = await getCreator(g.userId);
    return NextResponse.json({ creator, termsVersion: PROVIDER_TERMS_VERSION, termsCurrent: creator ? creator.termsVersion === PROVIDER_TERMS_VERSION : false }, { headers: NO_STORE });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ creator: null, termsVersion: PROVIDER_TERMS_VERSION, termsCurrent: false, ready: false }, { headers: NO_STORE });
    console.error("[creator:get]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load that right now." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const g = await guard();
  if ("error" in g) return g.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const res = await enrollCreator(g.userId, body);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ creator: res.creator, termsVersion: PROVIDER_TERMS_VERSION, termsCurrent: true }, { headers: NO_STORE });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json(SETTING_UP, { status: 503 });
    console.error("[creator:post]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const g = await guard();
  if ("error" in g) return g.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const res = await updateCreator(g.userId, body);
    if (!res.ok) return NextResponse.json({ error: res.error, code: "code" in res ? res.code : undefined }, { status: res.status });
    return NextResponse.json({ creator: res.creator, termsVersion: PROVIDER_TERMS_VERSION, termsCurrent: res.creator.termsVersion === PROVIDER_TERMS_VERSION }, { headers: NO_STORE });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json(SETTING_UP, { status: 503 });
    console.error("[creator:patch]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't save that. Try again." }, { status: 500 });
  }
}
