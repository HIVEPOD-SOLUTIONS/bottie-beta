import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const { currency, account_number, ifsc, account_holder_name, sub_account_id, wallet } = body as {
    currency?: string; account_number?: string; ifsc?: string; account_holder_name?: string; sub_account_id?: string; wallet?: string;
  };
  if (!currency) return Response.json({ error: "currency is required" }, { status: 422 });
  if (!account_number) return Response.json({ error: "account_number is required" }, { status: 422 });
  if (!ifsc) return Response.json({ error: "ifsc is required" }, { status: 422 });
  if (!account_holder_name) return Response.json({ error: "account_holder_name is required" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.validateBankAccount !== "function")
      return Response.json({ error: "Validation not supported" }, { status: 501 });
    const data = await provider.validateBankAccount({ currency, account_number, ifsc, account_holder_name, sub_account_id, wallet });
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
