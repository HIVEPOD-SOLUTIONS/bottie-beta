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
  const currency = searchParams.get("currency") ?? "usd";
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getPayoutBalance !== "function")
      return Response.json({ error: "Payout not supported" }, { status: 501 });
    const data = await provider.getPayoutBalance(currency);
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
