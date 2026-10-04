import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

// GET /api/banking/[provider]/offramp/bank-accounts?customer_id=xxx
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  const { searchParams } = new URL(req.url);
  const customer_id = searchParams.get("customer_id");
  if (!customer_id) return Response.json({ error: "customer_id is required" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.listBankAccounts !== "function")
      return Response.json({ error: "Offramp not supported by this provider" }, { status: 501 });
    const data = await provider.listBankAccounts(customer_id);
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

// POST /api/banking/[provider]/offramp/bank-accounts
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  let userId: string;
  try { const auth = await verifyAuth(); userId = auth.userId; } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const { first_name, last_name, account_number, ifsc } = body as {
    first_name?: string; last_name?: string; account_number?: string; ifsc?: string;
  };
  if (!first_name) return Response.json({ error: "first_name is required" }, { status: 422 });
  if (!last_name) return Response.json({ error: "last_name is required" }, { status: 422 });
  if (!account_number) return Response.json({ error: "account_number is required" }, { status: 422 });
  if (!ifsc) return Response.json({ error: "ifsc is required" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.addBankAccount !== "function")
      return Response.json({ error: "Offramp not supported by this provider" }, { status: 501 });
    const data = await provider.addBankAccount({ customer_id: userId, first_name, last_name, account_number, ifsc });
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
