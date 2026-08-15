/** POST /api/nosana/deployments/:id/archive */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { id } = await params;
  try {
    const { archiveDeployment } = await import("@/lib/nosana");
    return NextResponse.json(await archiveDeployment(id));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
