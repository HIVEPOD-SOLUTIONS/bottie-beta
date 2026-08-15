import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const sp = new URL(req.url).searchParams;
  try {
    const { listRedemptions } = await import("@/lib/grail");
    return NextResponse.json(await listRedemptions({
      grail_user_id: sp.get("grail_user_id") ?? undefined,
      status: sp.get("status") ?? undefined,
      city: sp.get("city") ?? undefined,
    }));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const { grail_user_id, denomination_id, city } = await req.json().catch(() => ({}));
  if (!grail_user_id || !denomination_id || !city)
    return NextResponse.json({ error: "grail_user_id, denomination_id, and city required" }, { status: 400 });
  try {
    const { quoteRedemption } = await import("@/lib/grail");
    return NextResponse.json(await quoteRedemption(grail_user_id, denomination_id, city));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
