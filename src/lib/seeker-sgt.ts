import { getUserWalletAddresses } from "@/lib/auth";
import { getServerEnv } from "@/lib/server-env";
import { forwardRpc, TOKEN_2022_PROGRAM, type RpcRequest } from "@/lib/solana-rpc-proxy";

/**
 * Whether someone holds a Seeker Genesis Token (SGT), checked on the server so the Seeker perks (the Daily Spark multiplier and the
 * badge) can't be claimed by editing the app. The wallets checked are the ones Privy says are linked to the account, never an address
 * the app sends. Mirrors the app's own check (src/lib/seeker.ts there): Solana Mobile's SGT is a Token-2022 mint that is a member of
 * one token group, and the token account must hold a non-zero balance.
 *
 * Fails closed and quietly: if the RPC isn't configured or answers badly the person simply isn't treated as a holder this time, and
 * the failure isn't remembered, so the next collect tries again.
 */

/** Solana Mobile's SGT collection: every genuine SGT is a member of this group. */
export const SGT_GROUP = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
/** How many linked Solana wallets are looked at, and how many candidate mints per wallet. Keeps one collect to a handful of calls. */
const MAX_WALLETS = 3;
const MAX_MINTS = 10;
/** A definite answer is remembered this long (per server instance). Holding changes slowly. */
const CACHE_MS = 6 * 60 * 60 * 1000;

type Extension = { extension: string; state?: Record<string, unknown> };

/** Whether a parsed Token-2022 mint is an SGT: member of the group, with the metadata pointer agreeing. */
export function isSgtMint(extensions: Extension[] | undefined): boolean {
  if (!extensions) return false;
  const member = extensions.find((e) => e.extension === "tokenGroupMember");
  const pointer = extensions.find((e) => e.extension === "metadataPointer");
  return member?.state?.group === SGT_GROUP && pointer?.state?.metadataAddress === SGT_GROUP;
}

const cache = new Map<string, { holder: boolean; at: number }>();
export const clearSeekerCache = () => cache.clear();

async function call<T>(url: string, method: string, params: unknown[]): Promise<T | null> {
  const request: RpcRequest = { jsonrpc: "2.0", id: 1, method, params };
  const { status, body } = await forwardRpc(url, request);
  if (status !== 200) return null;
  try {
    const json = JSON.parse(body) as { result?: T; error?: unknown };
    return json.error ? null : (json.result ?? null);
  } catch {
    return null;
  }
}

type TokenAccounts = { value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null; decimals: number } } } } } }[] };
type MintInfo = { value: { data: { parsed?: { info?: { extensions?: Extension[] } } } } | null };

/** True/false when the RPC gave a clear answer for this wallet, null when it could not be asked. */
async function walletHoldsSgt(url: string, wallet: string): Promise<boolean | null> {
  const accounts = await call<TokenAccounts>(url, "getTokenAccountsByOwner", [wallet, { programId: TOKEN_2022_PROGRAM }, { encoding: "jsonParsed" }]);
  if (!accounts) return null;
  // An SGT is a one-of-one with 0 decimals. An emptied token account (the SGT moved away) must not count.
  const candidates = accounts.value
    .map((a) => a.account.data.parsed.info)
    .filter((i) => i.tokenAmount.decimals === 0 && (i.tokenAmount.uiAmount ?? 0) > 0)
    .map((i) => i.mint)
    .slice(0, MAX_MINTS);
  for (const mint of candidates) {
    const info = await call<MintInfo>(url, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    if (!info) return null;
    if (isSgtMint(info.value?.data?.parsed?.info?.extensions)) return true;
  }
  return false;
}

/** Whether this account has a Seeker Genesis Token in any of its linked Solana wallets. Never throws. */
export async function isSeekerHolder(userId: string, now: number = Date.now()): Promise<boolean> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < CACHE_MS) return hit.holder;
  const url = getServerEnv("HELIUS_RPC_URL");
  if (!url) return false;
  try {
    const { solana } = await getUserWalletAddresses(userId);
    let answered = true;
    for (const wallet of [...new Set(solana)].slice(0, MAX_WALLETS)) {
      const held = await walletHoldsSgt(url, wallet);
      if (held === true) {
        cache.set(userId, { holder: true, at: now });
        return true;
      }
      if (held === null) answered = false;
    }
    if (answered) cache.set(userId, { holder: false, at: now });
    return false;
  } catch (err) {
    console.warn("[seeker] couldn't check for a Seeker Genesis Token:", err instanceof Error ? err.message : err);
    return false;
  }
}
