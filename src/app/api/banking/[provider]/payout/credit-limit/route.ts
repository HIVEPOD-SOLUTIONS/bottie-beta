import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

// GET /api/banking/[provider]/payout/credit-limit?currency=usdt
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  const currency = new URL(req.url).searchParams.get("currency") ?? "usdt";

  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getPayoutCreditLimit !== "function")
      return Response.json({ error: "Credit limit not supported by this provider" }, { status: 501 });
    return Response.json(await provider.getPayoutCreditLimit(currency));
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
