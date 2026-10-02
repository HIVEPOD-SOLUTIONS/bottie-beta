import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

// GET /api/banking/[provider]/payout/info?payout_id=xxx
// GET /api/banking/[provider]/payout/info?merchant_payout_id=xxx
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  const sp = new URL(req.url).searchParams;
  const payout_id = sp.get("payout_id") ?? undefined;
  const merchant_payout_id = sp.get("merchant_payout_id") ?? undefined;
  if (!payout_id && !merchant_payout_id)
    return Response.json({ error: "payout_id or merchant_payout_id required" }, { status: 422 });

  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getPayoutInfo !== "function")
      return Response.json({ error: "Payout info not supported by this provider" }, { status: 501 });
    return Response.json(await provider.getPayoutInfo({ payout_id, merchant_payout_id }));
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
