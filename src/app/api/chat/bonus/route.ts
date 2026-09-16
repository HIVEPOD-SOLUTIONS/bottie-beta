import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { grantChatBonus } from "@/lib/user-rate-limiter";

export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const amount = typeof body?.amount === "number" && body.amount > 0 ? Math.min(body.amount, 100) : 5;

  grantChatBonus(userId, amount);
  return NextResponse.json({ granted: amount });
}
