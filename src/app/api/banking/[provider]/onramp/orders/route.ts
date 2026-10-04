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
  const page = Number(searchParams.get("page") ?? "0");
  const limit = Number(searchParams.get("limit") ?? "10");
  const status = searchParams.get("status") ?? undefined;
  const customer_id = searchParams.get("customer_id") ?? undefined;
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.isConfigured === "function" && !provider.isConfigured())
      return Response.json({ error: `${providerId} API credentials not configured` }, { status: 503 });
    if (typeof provider.listOnrampOrders !== "function")
      return Response.json({ error: "Onramp not supported by this provider" }, { status: 501 });
    const data = await provider.listOnrampOrders({ page, limit, status, customer_id });
    return Response.json(data);
  } catch (err: any) {
    const message = err?.message ?? "Failed";
    console.error(`[banking/${providerId}/onramp/orders]`, message);
    return Response.json({ error: message }, { status: 502 });
  }
}
