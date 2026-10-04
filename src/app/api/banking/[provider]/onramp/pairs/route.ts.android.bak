import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getOnrampPairs !== "function")
      return Response.json({ error: "Onramp not supported by this provider" }, { status: 501 });
    const data = await provider.getOnrampPairs();
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
