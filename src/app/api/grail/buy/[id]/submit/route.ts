/**
 * POST /api/grail/buy/[id]/submit
 * Submit a fully-signed (GRAIL + partner + user) buy transaction to GRAIL.
 *
 * Body: { signed_tx: string (base64) }
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { id } = await params;
  const { signed_tx } = await req.json().catch(() => ({}));
  if (!signed_tx) return NextResponse.json({ error: "signed_tx required" }, { status: 400 });
  try {
    const { submitBuy } = await import("@/lib/grail");
    return NextResponse.json(await submitBuy(id, signed_tx));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
