/**
 * GET  /api/nosana/deployments — list the calling user's OWN deployments
 * POST /api/nosana/deployments — create a deployment (returns DRAFT; caller should then POST /start)
 *
 * Nosana's account is shared across all Bluvfi users (one API key, no per-user concept on
 * Nosana's side), so every response here is filtered/recorded against the local ownership
 * table in @/lib/nosana-deployments — see that file for why.
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET() {
  let userId: string;
  try {
    userId = (await verifyAuth()).userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const { listDeployments } = await import("@/lib/nosana");
    const { filterToOwnedDeployments } = await import("@/lib/nosana-deployments");
    const { deployments } = await listDeployments();
    return NextResponse.json({ deployments: await filterToOwnedDeployments(userId, deployments) });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = (await verifyAuth()).userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const { name, market, timeout, replicas, strategy, job_definition } = body;
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!market) return NextResponse.json({ error: "market required" }, { status: 400 });
  if (!job_definition) return NextResponse.json({ error: "job_definition required" }, { status: 400 });
  try {
    const { createDeployment } = await import("@/lib/nosana");
    const { recordNosanaDeployment } = await import("@/lib/nosana-deployments");
    const dep = await createDeployment({
      name,
      market,
      timeout: timeout ?? 60,
      replicas: replicas ?? 1,
      strategy: strategy ?? "SIMPLE",
      job_definition,
    });
    await recordNosanaDeployment(userId, dep.id);
    return NextResponse.json(dep);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
