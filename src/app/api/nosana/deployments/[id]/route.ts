/** GET /api/nosana/deployments/:id */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { id } = await params;
  try {
    const { getDeployment } = await import("@/lib/nosana");
    return NextResponse.json(await getDeployment(id));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
