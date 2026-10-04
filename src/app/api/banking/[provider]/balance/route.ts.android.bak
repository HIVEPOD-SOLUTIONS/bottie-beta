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
  const subAccountId = searchParams.get("sub_account_id") ?? "main";

  try {
    const provider = getProvider(providerId);
    const balance = await provider.getBalance(subAccountId);
    return Response.json(balance);
  } catch (err: any) {
    const status = err?.message?.startsWith("Unknown banking provider") ? 404 : 502;
    return Response.json({ error: err?.message ?? "Failed" }, { status });
  }
}
