import { getServerEnv } from "@/lib/server-env";

/**
 * Server-side Solana access. The RPC URL comes from the server's own settings and never reaches a client.
 * Preference order: HELIUS_RPC_URL (dedicated, supports everything we need), FLASH_SOLANA_RPC, then the Alchemy key.
 */
export function solanaRpcUrl(): string {
  const dedicated = getServerEnv("HELIUS_RPC_URL") ?? getServerEnv("FLASH_SOLANA_RPC");
  if (dedicated) return dedicated;
  const alchemy = getServerEnv("NEXT_PUBLIC_ALCHEMY_API_KEY");
  if (alchemy) return `https://solana-mainnet.g.alchemy.com/v2/${alchemy}`;
  return "https://api.mainnet-beta.solana.com";
}

/** One JSON-RPC call. Throws a plain Error (never including the URL, which carries a key) on any failure. */
export async function rpcCall<T>(method: string, params: unknown[], timeoutMs = 12_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(solanaRpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new Error("Solana RPC is unreachable");
  }
  const json = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!res.ok || !json) throw new Error(`Solana RPC failed (${res.status})`);
  if (json.error) throw new Error(json.error.message ?? "Solana RPC error");
  return json.result as T;
}
