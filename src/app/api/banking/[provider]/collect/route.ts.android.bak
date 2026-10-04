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

  const { amount, description, customerRef } = body as {
    amount?: number;
    description?: string;
    customerRef?: string;
  };

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return Response.json({ error: "amount must be a positive number" }, { status: 422 });
  }

  try {
    const provider = getProvider(providerId);

    if (amount < provider.minCollectionAmount) {
      return Response.json(
        { error: `Minimum collection amount is ${provider.currencySymbol}${provider.minCollectionAmount}` },
        { status: 422 },
      );
    }

    const result = await provider.initiateCollection(userId, { amount, description, customerRef });

    // Record pending collection — webhook updates status to completed/failed
    const anyResult = result as any;
    const collectionId = anyResult?.data?.collection_id ?? anyResult?.collection_id ?? null;
    const merchantRef  = anyResult?.data?.merchant_collection_id ?? anyResult?.merchant_collection_id ?? collectionId;
    db.insert(payments).values({
      userId,
      type: "onramp",
      referenceId: merchantRef ? String(merchantRef) : null,
      description: description ? `UPI collection: ${description}` : `UPI collection: ${providerId} ₹${amount}`,
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
