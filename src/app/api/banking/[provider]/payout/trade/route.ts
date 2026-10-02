import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  let userId: string;
  try { const auth = await verifyAuth(); userId = auth.userId; } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const { from_currency, to_currency, from_amount, sub_account_id, merchant_trade_id } = body as {
    from_currency?: string; to_currency?: string; from_amount?: number; sub_account_id?: string; merchant_trade_id?: string;
  };
  if (!from_currency) return Response.json({ error: "from_currency is required" }, { status: 422 });
  if (!to_currency) return Response.json({ error: "to_currency is required" }, { status: 422 });
  if (!from_amount || from_amount <= 0) return Response.json({ error: "from_amount must be positive" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.initiateTrade !== "function")
      return Response.json({ error: "Trades not supported" }, { status: 501 });
    const data = await provider.initiateTrade({ from_currency, to_currency, from_amount, sub_account_id, merchant_trade_id });

    // Record the trade in the payments ledger
    const tradeId = data?.data?.trade_id ?? data?.trade_id ?? merchant_trade_id ?? null;
    db.insert(payments).values({
      userId,
      type: "transfer",
      referenceId: tradeId ? String(tradeId) : null,
      description: `Banking FX trade: ${from_amount} ${from_currency?.toUpperCase()} → ${to_currency?.toUpperCase()} via ${providerId}`,
      amountUsdc: String(from_amount),
      status: "pending",
      chain: "evm",
    }).catch(() => {});

    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  const { searchParams } = new URL(req.url);
  const opts = {
    page: Number(searchParams.get("page") ?? "1"),
    limit: Number(searchParams.get("limit") ?? "10"),
    from_currency: searchParams.get("from_currency") ?? undefined,
    to_currency: searchParams.get("to_currency") ?? undefined,
    sub_account_id: searchParams.get("sub_account_id") ?? undefined,
  };
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getTradeHistory !== "function")
      return Response.json({ error: "Trade history not supported" }, { status: 501 });
    const data = await provider.getTradeHistory(opts);
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
