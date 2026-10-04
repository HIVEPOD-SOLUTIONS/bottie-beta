import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

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
    page: Number(searchParams.get("page") ?? "0"),
    limit: Number(searchParams.get("limit") ?? "10"),
    status: searchParams.get("status") ?? undefined,
    sub_account_id: searchParams.get("sub_account_id") ?? undefined,
    payout_id: searchParams.get("payout_id") ?? undefined,
    merchant_payout_id: searchParams.get("merchant_payout_id") ?? undefined,
  };
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.listPayouts !== "function")
      return Response.json({ error: "Payout list not supported" }, { status: 501 });
    const data = await provider.listPayouts(opts);
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
