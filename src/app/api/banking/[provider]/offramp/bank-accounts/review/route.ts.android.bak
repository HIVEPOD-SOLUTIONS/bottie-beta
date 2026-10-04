import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

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
  if (!first_name || !last_name || !account_number || !ifsc)
    return Response.json({ error: "first_name, last_name, account_number and ifsc are required" }, { status: 422 });
  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.reviewBankAccount !== "function")
      return Response.json({ error: "Offramp not supported by this provider" }, { status: 501 });
    const data = await provider.reviewBankAccount({ customer_id: userId, first_name, last_name, account_number, ifsc });
    return Response.json(data);
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
