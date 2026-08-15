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

  const { amount, description, beneficiaryName, beneficiaryAccountNumber, beneficiaryIfsc } = body as {
    amount?: number;
    description?: string;
    beneficiaryName?: string;
    beneficiaryAccountNumber?: string;
    beneficiaryIfsc?: string;
  };

  if (!amount || typeof amount !== "number" || amount <= 0)
    return Response.json({ error: "amount must be a positive number" }, { status: 422 });
  if (!beneficiaryName || !beneficiaryAccountNumber || !beneficiaryIfsc)
    return Response.json({ error: "beneficiaryName, beneficiaryAccountNumber, and beneficiaryIfsc are required" }, { status: 422 });

  try {
    const provider = getProvider(providerId);
    const result = await provider.initiatePayout(userId, {
      amount, description, beneficiaryName, beneficiaryAccountNumber, beneficiaryIfsc,
    });

    // Persist to payments ledger — webhook updates status to completed/failed
    const anyResult = result as any;
    const payoutId = anyResult?.data?.payout_id ?? anyResult?.payout_id ?? null;
    const merchantRef = anyResult?.data?.merchant_payout_id ?? anyResult?.merchant_payout_id ?? payoutId;
    db.insert(payments).values({
      userId,
      type: "offramp",
      referenceId: merchantRef ? String(merchantRef) : null,
      description: description
        ? `Bank payout: ${description} → ${beneficiaryName}`
        : `Bank payout to ${beneficiaryName} (${beneficiaryAccountNumber?.slice(-4)})`,
      amountUsdc: String(amount),
      status: "pending",
      chain: "evm",
    }).catch(() => {});

    return Response.json(result);
  } catch (err: any) {
    const status = err?.message?.startsWith("Unknown banking provider") ? 404 : 502;
    return Response.json({ error: err?.message ?? "Failed" }, { status });
  }
}
