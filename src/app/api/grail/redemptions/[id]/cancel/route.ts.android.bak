import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { id } = await params;
  const { reason } = await req.json().catch(() => ({}));
  if (!reason) return NextResponse.json({ error: "reason required" }, { status: 400 });
  try {
    const { cancelRedemption } = await import("@/lib/grail");
    return NextResponse.json(await cancelRedemption(id, reason));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
