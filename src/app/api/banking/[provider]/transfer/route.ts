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

  const { amount, currency } = body as { amount?: number; currency?: string };
  if (!amount || typeof amount !== "number" || amount <= 0)
    return Response.json({ error: "amount must be a positive number" }, { status: 422 });

  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.transferToPayout !== "function")
      return Response.json({ error: "Transfer not supported by this provider" }, { status: 501 });
    const result = await provider.transferToPayout(currency ?? "INR", amount);

    // Record internal banking transfer (collection wallet → payout wallet)
    db.insert(payments).values({
      userId,
      type: "transfer",
      referenceId: (result as any)?.data?.transfer_id ?? (result as any)?.transfer_id ?? null,
      description: `Banking internal transfer: ${amount} ${(currency ?? "INR").toUpperCase()} via ${providerId}`,
      amountUsdc: String(amount),
      status: "completed",
      chain: "evm",
    }).catch(() => {});

    return Response.json(result);
  } catch (err: any) {
    const status = err?.message?.startsWith("Unknown banking provider") ? 404 : 502;
    return Response.json({ error: err?.message ?? "Failed" }, { status });
  }
}
