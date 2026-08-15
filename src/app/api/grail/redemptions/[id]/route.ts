import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { id } = await params;
  try {
    const { getRedemption } = await import("@/lib/grail");
    return NextResponse.json(await getRedemption(id));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
