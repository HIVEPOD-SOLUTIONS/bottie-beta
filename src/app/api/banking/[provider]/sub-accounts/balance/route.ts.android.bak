import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

// GET /api/banking/[provider]/sub-accounts/balance?currency=usd&sub_account_id=main
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  const sp = new URL(req.url).searchParams;
  const currency = sp.get("currency") ?? "usd";
  const sub_account_id = sp.get("sub_account_id") ?? "main";

  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getSubAccountBalance !== "function")
      return Response.json({ error: "Sub-account balance not supported by this provider" }, { status: 501 });
    return Response.json(await provider.getSubAccountBalance(currency, sub_account_id));
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
