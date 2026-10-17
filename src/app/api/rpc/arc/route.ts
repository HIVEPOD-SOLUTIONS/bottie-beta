/**
 * POST /api/rpc/arc — same-origin JSON-RPC proxy for Arc mainnet.
 *
 * Browsers with ad/privacy blockers (Brave Shields, uBlock…) block requests to
 * rpc.mainnet.arc.io, which breaks Privy's embedded wallet (nonce, gas, receipts).
 * arc-chain.ts points the browser at this route instead. Public chain data only:
 * a method allowlist, a body-size cap and a batch cap keep it from being an open relay.
 */

import { NextResponse } from "next/server";

const UPSTREAM = "https://rpc.mainnet.arc.io";
const MAX_BODY = 100_000;
const MAX_BATCH = 20;

const ALLOWED = new Set([
  "eth_chainId", "net_version", "web3_clientVersion",
  "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_call", "eth_estimateGas", "eth_fillTransaction", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs",
  "eth_sendRawTransaction",
]);

type RpcCall = { method?: unknown };

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > MAX_BODY) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const calls = Array.isArray(body) ? (body as RpcCall[]) : [body as RpcCall];
  if (calls.length === 0 || calls.length > MAX_BATCH) return NextResponse.json({ error: "bad_batch" }, { status: 400 });
  for (const c of calls) {
    if (!c || typeof c.method !== "string" || !ALLOWED.has(c.method)) {
      return NextResponse.json({ error: "method_not_allowed" }, { status: 400 });
    }
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: text,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "upstream_unreachable" }, { status: 502 });
  }
}
