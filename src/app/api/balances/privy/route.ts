/**
 * GET /api/balances/privy
 *
 * Server-side proxy to Privy's wallet balance API for both EVM and Solana.
 * Uses PRIVY_APP_SECRET — never exposed to the browser.
 *
 * Query params:
 *   evmWalletId  — Privy embedded EVM wallet ID  (user.wallet.id)
 *   solWalletId  — Privy embedded Solana wallet ID
 *   chains       — comma-separated EVM chains (default: all supported)
 *
 * Returns: { evmUsdc, evmUsdt, solUsdc, solUsdt }
 *
 * Docs: https://docs.privy.io/wallets/gas-and-asset-management/assets/fetch-balance
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";

const PRIVY_API = "https://api.privy.io/v1";

// ── EVM chain config ──────────────────────────────────────────────────────────
const EVM_CHAINS: Record<string, { usdtContract: string }> = {
  base:      { usdtContract: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" },
  ethereum:  { usdtContract: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  polygon:   { usdtContract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
  arbitrum:  { usdtContract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
  optimism:  { usdtContract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" },
  avalanche: { usdtContract: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7" },
};

// ── Solana token mints ────────────────────────────────────────────────────────
const SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeAuthHeader(appId: string, appSecret: string) {
  return `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`;
}

function parseEntries(
  data: Array<{ asset?: string; token?: string; formatted_amount?: string; amount?: string }>,
  usdtContract?: string,
): { usdc: number; usdt: number } {
  let usdc = 0;
  let usdt = 0;
  for (const entry of data) {
    const amount = parseFloat(entry.formatted_amount ?? entry.amount ?? "0") || 0;
    const label  = (entry.asset ?? entry.token ?? "").toLowerCase();
    if (label === "usdc" || label.includes("usdc")) {
      usdc += amount;
    } else if (
      label === "usdt" ||
      label.includes("usdt") ||
      (usdtContract && label.includes(usdtContract.toLowerCase()))
    ) {
      usdt += amount;
    }
  }
  return { usdc, usdt };
}

// Fetch one EVM chain's USDC + USDT from Privy
async function fetchEvmChain(
  walletId: string,
  chain: string,
  authHeader: string,
  appId: string,
): Promise<{ usdc: number; usdt: number }> {
  const { usdtContract } = EVM_CHAINS[chain]!;
  const params = new URLSearchParams();
  params.append("asset", "usdc");
  params.append("chain", chain);
  params.append("token", `${chain}:${usdtContract}`);

  const res = await fetch(
    `${PRIVY_API}/wallets/${encodeURIComponent(walletId)}/balance?${params}`,
    { headers: { Authorization: authHeader, "privy-app-id": appId }, signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return { usdc: 0, usdt: 0 };
  const json = await res.json();
  return parseEntries(json?.data ?? [], usdtContract);
}

// Fetch Solana USDC + USDT from Privy
async function fetchSolanaWallet(
  walletId: string,
  authHeader: string,
  appId: string,
): Promise<{ usdc: number; usdt: number }> {
  const params = new URLSearchParams();
  params.append("token", `solana:${SOL_USDC_MINT}`);
  params.append("token", `solana:${SOL_USDT_MINT}`);

  const res = await fetch(
    `${PRIVY_API}/wallets/${encodeURIComponent(walletId)}/balance?${params}`,
    { headers: { Authorization: authHeader, "privy-app-id": appId }, signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return { usdc: 0, usdt: 0 };
  const json = await res.json();
  const data: Array<any> = json?.data ?? [];
  let usdc = 0;
  let usdt = 0;
  for (const entry of data) {
    const amount = parseFloat(entry.formatted_amount ?? entry.amount ?? "0") || 0;
    const token  = (entry.token ?? "").toLowerCase();
    if (token.includes(SOL_USDC_MINT.toLowerCase())) usdc += amount;
    else if (token.includes(SOL_USDT_MINT.toLowerCase())) usdt += amount;
  }
  return { usdc, usdt };
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    await verifyAuth();
  } catch (err) {
    return authErrorResponse(err);
  }

  const appId     = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    return NextResponse.json({ error: "Privy credentials not configured" }, { status: 503 });
  }

  const { searchParams } = req.nextUrl;
  const evmWalletId = searchParams.get("evmWalletId");
  const solWalletId = searchParams.get("solWalletId");
  const chainsParam = searchParams.get("chains");

  if (!evmWalletId && !solWalletId) {
    return NextResponse.json({ error: "evmWalletId or solWalletId required" }, { status: 400 });
  }

  const chains = chainsParam
    ? chainsParam.split(",").filter((c) => EVM_CHAINS[c])
    : Object.keys(EVM_CHAINS);

  const authHeader = makeAuthHeader(appId, appSecret);

  try {
    const [evmResults, solResult] = await Promise.all([
      // EVM: all chains in parallel
      evmWalletId
        ? Promise.all(chains.map((c) => fetchEvmChain(evmWalletId, c, authHeader, appId)))
        : Promise.resolve([] as { usdc: number; usdt: number }[]),
      // Solana
      solWalletId
        ? fetchSolanaWallet(solWalletId, authHeader, appId)
        : Promise.resolve({ usdc: 0, usdt: 0 }),
    ]);

    const evmUsdc = evmResults.reduce((s, r) => s + r.usdc, 0);
    const evmUsdt = evmResults.reduce((s, r) => s + r.usdt, 0);

    return NextResponse.json({
      evmUsdc,
      evmUsdt,
      solUsdc: solResult.usdc,
      solUsdt: solResult.usdt,
    });
  } catch (err) {
    console.error("[privy-balance]", err);
    return NextResponse.json({ error: "Balance fetch failed" }, { status: 502 });
  }
}
