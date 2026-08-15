import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

// GET /api/banking/[provider]/onramp/order?order_id=xxx
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  const { searchParams } = new URL(req.url);
  const orderId = searchParams.get("order_id");
  if (!orderId) return Response.json({ error: "order_id is required" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getOnrampOrder !== "function")
      return Response.json({ error: "Onramp not supported by this provider" }, { status: 501 });
    const data = await provider.getOnrampOrder(orderId);
    return Response.json(data);
  } catch (err: any) {
    const status = err?.message?.startsWith("Unknown banking provider") ? 404 : 502;
    return Response.json({ error: err?.message ?? "Failed" }, { status });
  }
}

// POST /api/banking/[provider]/onramp/order — create an onramp order and record it as pending
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
  const { pair_id, amount, first_name, last_name, destination_address } = body as {
    pair_id?: string; amount?: number; first_name?: string; last_name?: string; destination_address?: string;
  };
  if (!pair_id) return Response.json({ error: "pair_id is required" }, { status: 422 });
  if (!amount || typeof amount !== "number" || amount <= 0)
    return Response.json({ error: "amount must be a positive number" }, { status: 422 });
  if (!first_name) return Response.json({ error: "first_name is required" }, { status: 422 });
  if (!last_name) return Response.json({ error: "last_name is required" }, { status: 422 });
  if (!destination_address) return Response.json({ error: "destination_address is required" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.createOnrampOrder !== "function")
      return Response.json({ error: "Onramp not supported by this provider" }, { status: 501 });
    const data = await provider.createOnrampOrder({
      pair_id, amount, customer_id: userId, first_name, last_name, destination_address,
    });

    // Record pending onramp — webhook updates status to completed/failed
    const orderId = data?.data?.order_id ?? data?.order_id ?? null;
    if (orderId) {
      db.insert(payments).values({
        userId,
        type: "onramp",
        referenceId: orderId,
        description: `Onramp: ${amount} ${(pair_id as string).split("-")[1]?.toUpperCase() ?? "crypto"} via ${providerId} (${pair_id})`,
        amountUsdc: String(amount),
        status: "pending",
        chain: "evm",
      }).catch(() => {});
    }

    return Response.json(data);
  } catch (err: any) {
    const status = err?.message?.startsWith("Unknown banking provider") ? 404 : 502;
    return Response.json({ error: err?.message ?? "Failed" }, { status });
  }
}
