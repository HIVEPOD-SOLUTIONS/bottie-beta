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
  const sub_account_id = searchParams.get("sub_account_id") ?? "main";
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getDepositHistory !== "function")
      return Response.json({ error: "Deposits not supported" }, { status: 501 });
    const data = await provider.getDepositHistory({ page, limit, sub_account_id });
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
