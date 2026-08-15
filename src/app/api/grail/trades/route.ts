import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const sp = new URL(req.url).searchParams;
  try {
    const { listTrades } = await import("@/lib/grail");
    return NextResponse.json(await listTrades({
      grail_user_id: sp.get("grail_user_id") ?? undefined,
      side: (sp.get("side") as "buy" | "sell") ?? undefined,
      status: sp.get("status") ?? undefined,
      limit: sp.has("limit") ? Number(sp.get("limit")) : undefined,
    }));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
