import { NextResponse } from "next/server";
import { getQueue, recentAudit } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-auth";
import { isMissingTable } from "@/lib/shar";

/** GET /api/admin/queue — listings waiting for review, payouts waiting to be clicked or still sending, the treasury and recent actions. */
export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;
  try {
    const [queue, audit] = await Promise.all([getQueue(), recentAudit(15)]);
    return NextResponse.json({ ...queue, audit }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "The admin tables aren't set up yet. Run drizzle/0007 and 0008 on the database." }, { status: 503 });
    console.error("[admin/queue]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load the queue." }, { status: 500 });
  }
}
