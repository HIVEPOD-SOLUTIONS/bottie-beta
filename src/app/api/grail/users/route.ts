import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET() {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  try {
    const { listGrailUsers } = await import("@/lib/grail");
    return NextResponse.json(await listGrailUsers());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const body = await req.json().catch(() => ({}));
  const { wallet_address, full_name, country } = body;
  if (!wallet_address) return NextResponse.json({ error: "wallet_address required" }, { status: 400 });
  try {
    const { findOrCreateGrailUser } = await import("@/lib/grail");
    const result = await findOrCreateGrailUser({
      walletAddress: wallet_address,
      fullName: full_name ?? "Bluvfi User",
      country: country ?? "US",
    });
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
