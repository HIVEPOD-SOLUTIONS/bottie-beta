import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getOrderForUser } from "@/lib/stocks";
import { stocksErrorResponse } from "@/lib/stocks-http";

/** GET /api/stocks/orders/[id] — the user's order, synced with Backpack (books fills). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  try {
    const order = await getOrderForUser(userId, id);
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    return NextResponse.json({ order }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return stocksErrorResponse(err, "order");
  }
}
