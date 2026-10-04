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
    if (typeof provider.getOfframpPairs !== "function")
      return Response.json({ error: "Offramp not supported by this provider" }, { status: 501 });
    const data = await provider.getOfframpPairs();
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
