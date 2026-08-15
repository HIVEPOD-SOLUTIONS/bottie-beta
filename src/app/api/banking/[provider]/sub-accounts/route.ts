import { verifyAuth } from "@/lib/auth";
import { getProvider } from "@/lib/banking/registry";

// GET /api/banking/[provider]/sub-accounts?page=0&limit=10
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  const sp = new URL(req.url).searchParams;
  const page = Number(sp.get("page") ?? "0");
  const limit = Number(sp.get("limit") ?? "10");

  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.getAllSubAccounts !== "function")
      return Response.json({ error: "Sub-accounts not supported by this provider" }, { status: 501 });
    return Response.json(await provider.getAllSubAccounts(page, limit));
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}

// POST /api/banking/[provider]/sub-accounts — create a new sub-account
// Body: { label?: string }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try { await verifyAuth(); } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const { provider: providerId } = await params;
  const { label } = await req.json().catch(() => ({})) as { label?: string };

  try {
    const provider = getProvider(providerId) as any;
    if (typeof provider.createSubAccount !== "function")
      return Response.json({ error: "Sub-accounts not supported by this provider" }, { status: 501 });
    return Response.json(await provider.createSubAccount(label));
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
