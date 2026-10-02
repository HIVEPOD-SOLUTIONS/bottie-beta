import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";

// POST /api/banking/[provider]/sub-accounts/transfer
// Body: { amount: number; currency: string; from_sub_account_id?: string; to_sub_account_id?: string }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  let userId: string;
  try { const auth = await verifyAuth(); userId = auth.userId; } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;

  let body: { amount?: number; currency?: string; from_sub_account_id?: string; to_sub_account_id?: string };
  try { body = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { amount, currency, from_sub_account_id, to_sub_account_id } = body;
  if (!amount || typeof amount !== "number" || amount <= 0)
    return Response.json({ error: "amount must be a positive number" }, { status: 422 });
  if (!currency)
    return Response.json({ error: "currency is required" }, { status: 422 });

  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.transferSubAccountFunds !== "function")
      return Response.json({ error: "Sub-account transfer not supported by this provider" }, { status: 501 });
    const result = await provider.transferSubAccountFunds({ amount, currency, from_sub_account_id, to_sub_account_id });

    // Record the sub-account transfer
    const transferId = result?.data?.transfer_id ?? result?.transfer_id ?? null;
    db.insert(payments).values({
      userId,
      type: "transfer",
      referenceId: transferId ? String(transferId) : null,
      description: `Sub-account transfer: ${amount} ${currency.toUpperCase()} via ${providerId}${from_sub_account_id ? ` from ${from_sub_account_id}` : ""}${to_sub_account_id ? ` to ${to_sub_account_id}` : ""}`,
      amountUsdc: String(amount),
      status: "completed",
      chain: "evm",
    }).catch(() => {});

    return Response.json(result);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
