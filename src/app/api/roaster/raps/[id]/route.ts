/**
 * GET /api/roaster/raps/:id — get a specific rap (status, bars, track_url, angles)
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
    const { getRap } = await import("@/lib/roaster");
    const rap = await getRap(id);
    return NextResponse.json(rap);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
