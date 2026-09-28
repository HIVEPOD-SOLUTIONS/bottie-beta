/** POST /api/nosana/deployments/:id/start — only for a deployment this user owns */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string;
  try {
    userId = (await verifyAuth()).userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { id } = await params;
  try {
    const { assertOwnsNosanaDeployment } = await import("@/lib/nosana-deployments");
    await assertOwnsNosanaDeployment(userId, id);
    const { startDeployment } = await import("@/lib/nosana");
    return NextResponse.json(await startDeployment(id));
  } catch (err: any) {
    const status = err?.name === "NosanaDeploymentNotOwnedError" ? 404 : 502;
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status });
  }
}
