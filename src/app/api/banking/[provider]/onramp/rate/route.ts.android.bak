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
  const pair_id = searchParams.get("pair_id");
  const amount = searchParams.get("amount");
  if (!pair_id) return Response.json({ error: "pair_id is required" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getOnrampRate !== "function")
      return Response.json({ error: "Onramp not supported by this provider" }, { status: 501 });
    const data = await provider.getOnrampRate(pair_id, amount ? Number(amount) : undefined);
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
