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
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getPayoutWalletLedger !== "function")
      return Response.json({ error: "Payout ledger not supported" }, { status: 501 });
    const data = await provider.getPayoutWalletLedger(page, limit);
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
