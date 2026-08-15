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

  const { currency, ...rest } = body as { currency?: string } & Record<string, unknown>;
  if (!currency) return Response.json({ error: "currency is required" }, { status: 422 });
  if (!rest.amount || typeof rest.amount !== "number" || (rest.amount as number) <= 0)
    return Response.json({ error: "amount must be a positive number" }, { status: 422 });
  if (!rest.account_holder_name)
    return Response.json({ error: "account_holder_name is required" }, { status: 422 });

  const provider = getProvider(providerId) as any;
  const cur = (currency as string).toLowerCase();

  try {
    let data;
    if (cur === "inr" || cur === "inr_e") {
      if (typeof provider.initiateInrPayout !== "function")
        return Response.json({ error: "INR payout not supported" }, { status: 501 });
      data = await provider.initiateInrPayout(userId, { ...rest, currency: cur });
    } else if (cur === "idr") {
      if (typeof provider.initiateIdrPayout !== "function")
        return Response.json({ error: "IDR payout not supported" }, { status: 501 });
      data = await provider.initiateIdrPayout(userId, rest);
    } else if (cur === "php") {
      if (typeof provider.initiatePhpPayout !== "function")
        return Response.json({ error: "PHP payout not supported" }, { status: 501 });
      data = await provider.initiatePhpPayout(userId, rest);
    } else if (cur === "vnd") {
      if (typeof provider.initiateVndPayout !== "function")
        return Response.json({ error: "VND payout not supported" }, { status: 501 });
      data = await provider.initiateVndPayout(userId, rest);
    } else {
      return Response.json({ error: `Unsupported payout currency: ${currency}` }, { status: 422 });
    }

    // Record pending payout — webhook updates to completed/failed via merchant_payout_id
    const payoutId = data?.data?.payout_id ?? data?.payout_id ?? null;
    const merchantPayoutId = data?.data?.merchant_payout_id ?? data?.merchant_payout_id ?? payoutId;
    const amount = rest.amount as number;
    db.insert(payments).values({
      userId,
      type: "offramp",
      referenceId: merchantPayoutId ? String(merchantPayoutId) : null,
      description: `${cur.toUpperCase()} payout: ${amount} via ${providerId}`,
      amountUsdc: String(amount),
      status: "pending",
      chain: "evm",
    }).catch(() => {});

    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
