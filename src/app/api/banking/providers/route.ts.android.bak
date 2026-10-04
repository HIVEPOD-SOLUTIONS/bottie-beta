import { getConfiguredProviders, getProviderMeta } from "@/lib/banking/registry";
import { verifyAuth } from "@/lib/auth";

export async function GET() {
  try {
    await verifyAuth();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const providers = getConfiguredProviders().map(getProviderMeta);
  return Response.json(providers);
}
