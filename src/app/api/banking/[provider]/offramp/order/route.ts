import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

// GET /api/banking/[provider]/offramp/order?order_id=xxx
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
    if (typeof provider.getOfframpOrder !== "function")
      return Response.json({ error: "Offramp not supported by this provider" }, { status: 501 });
    const data = await provider.getOfframpOrder(orderId);
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

// POST /api/banking/[provider]/offramp/order — create an offramp order and record it as pending
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
  const { pair_id, amount, first_name, last_name, bank_account_id } = body as {
    pair_id?: string; amount?: number; first_name?: string; last_name?: string; bank_account_id?: string;
  };
  if (!pair_id) return Response.json({ error: "pair_id is required" }, { status: 422 });
  if (!amount || typeof amount !== "number" || amount <= 0)
    return Response.json({ error: "amount must be a positive number" }, { status: 422 });
  if (!first_name) return Response.json({ error: "first_name is required" }, { status: 422 });
  if (!last_name) return Response.json({ error: "last_name is required" }, { status: 422 });
  if (!bank_account_id) return Response.json({ error: "bank_account_id is required" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.createOfframpOrder !== "function")
      return Response.json({ error: "Offramp not supported by this provider" }, { status: 501 });
    const data = await provider.createOfframpOrder({
      pair_id, amount, customer_id: userId, first_name, last_name, bank_account_id,
    });

    // Record pending offramp — webhook updates status to completed/failed
    const orderId = data?.data?.order_id ?? data?.order_id ?? null;
    if (orderId) {
      // Detect which chain the user will be sending from (embedded in the pair_id suffix)
      const pairChain = (pair_id as string).split("-").pop() ?? "evm";
      const chain = pairChain === "solana" ? "solana" : "evm";
      db.insert(payments).values({
        userId,
        type: "offramp",
        referenceId: orderId,
        description: `Offramp: ${amount} ${(pair_id as string).split("-")[0]?.toUpperCase() ?? "crypto"} via ${providerId} (${pair_id})`,
        amountUsdc: String(amount),
        status: "pending",
        chain,
      }).catch(() => {});
    }

    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
