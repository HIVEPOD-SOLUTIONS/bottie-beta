/**
 * GET  /api/nosana/deployments — list all deployments
 * POST /api/nosana/deployments — create a deployment (returns DRAFT; caller should then POST /start)
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET() {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  try {
    const { listDeployments } = await import("@/lib/nosana");
    return NextResponse.json(await listDeployments());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const body = await req.json().catch(() => ({}));
  const { name, market, timeout, replicas, strategy, job_definition } = body;
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!market) return NextResponse.json({ error: "market required" }, { status: 400 });
  if (!job_definition) return NextResponse.json({ error: "job_definition required" }, { status: 400 });
  try {
    const { createDeployment } = await import("@/lib/nosana");
    const dep = await createDeployment({
      name,
      market,
      timeout: timeout ?? 60,
      replicas: replicas ?? 1,
      strategy: strategy ?? "SIMPLE",
      job_definition,
    });
    return NextResponse.json(dep);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
