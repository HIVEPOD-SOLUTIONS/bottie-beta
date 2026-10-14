import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { createSquad, getSquadView, joinSquad, leaveSquad } from "@/lib/shar-squads";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * GET  /api/shar/squad — the signed-in user's squad (members' weeks, the weekly goal and its progress) and this week's squads board.
 * POST /api/shar/squad — { action: "create", name } | { action: "join", code } | { action: "leave" }. Open to every signed-in user.
 * 503 until drizzle/0017 has been applied. A squad is shown to strangers only by a generated name, never by what its members typed.
 */
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "shar-squad", 30, 1500);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  try {
    return NextResponse.json(await getSquadView(userId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[shar/squad]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load your squad right now." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const limit = await checkApiLimit(userId, "shar-squad-write", 10, 200);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  const body = (await req.json().catch(() => null)) as { action?: unknown; name?: unknown; code?: unknown } | null;
  try {
    const result =
      body?.action === "create" ? await createSquad(userId, body.name) : body?.action === "join" ? await joinSquad(userId, body.code) : body?.action === "leave" ? await leaveSquad(userId) : null;
    if (!result) return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const { ok: _ok, ...rest } = result;
    return NextResponse.json({ ...rest, view: await getSquadView(userId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[shar/squad]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't update your squad right now." }, { status: 500 });
  }
}
