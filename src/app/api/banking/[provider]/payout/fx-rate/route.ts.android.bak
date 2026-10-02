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
    input_currency: searchParams.get("input_currency") ?? undefined,
    output_currency: searchParams.get("output_currency") ?? undefined,
    type: searchParams.get("type") ?? undefined,
    purpose: searchParams.get("purpose") ?? undefined,
    party: searchParams.get("party") ?? undefined,
  };
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getFxRate !== "function")
      return Response.json({ error: "FX rate not supported" }, { status: 501 });
    const data = await provider.getFxRate(opts);
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
