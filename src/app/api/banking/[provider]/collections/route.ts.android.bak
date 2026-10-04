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
  const transactionId = searchParams.get("id");

  try {
    const provider = getProvider(providerId);
    if (transactionId) {
      const tx = await provider.getTransaction(transactionId);
      return Response.json(tx);
    }
    const list = await provider.getTransactions();
    return Response.json(list);
  } catch (err: any) {
    const status = err?.message?.startsWith("Unknown banking provider") ? 404 : 502;
    return Response.json({ error: err?.message ?? "Failed" }, { status });
  }
}
