/**
 * GET /api/roaster/battles/:id — get full battle details including pool sizes, status, and jury result
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { id } = await params;
  try {
    const { getBattle } = await import("@/lib/roaster");
    const battle = await getBattle(id);
    return NextResponse.json(battle);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
