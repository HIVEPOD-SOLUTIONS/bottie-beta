import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";

export async function GET() {
  try { await verifyAuth(); } catch { return new Response("Unauthorized", { status: 401 }); }
  try {
    const { getSolPayBalance } = await import("@/lib/solana-pay-kit");
    const balance = await getSolPayBalance();
    return NextResponse.json(balance);
  } catch (err: unknown) {
    return NextResponse.json({ error: (err as Error)?.message ?? "Failed" }, { status: 500 });
  }
}
