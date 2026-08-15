import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET(req: Request) {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  const country = new URL(req.url).searchParams.get("country") ?? "US";
  try {
    const { listDenominations } = await import("@/lib/grail");
    return NextResponse.json(await listDenominations(country));
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
