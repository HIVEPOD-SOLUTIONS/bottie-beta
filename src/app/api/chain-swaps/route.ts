import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { describeChainSwap, listUserChainSwaps } from "@/lib/chain-swaps";

/**
 * GET /api/chain-swaps — the user's payments from Zcash, Hyperliquid, Arc,
 * Robinhood Chain and Tempo, refreshed from bluvfi-xrpl, each with a plain
 * "where are my funds" line.
 */
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  try {
    const rows = await listUserChainSwaps(userId, 30);
    return NextResponse.json({
      swaps: rows.map((r) => ({
        id: r.walletRequestId,
        purpose: r.purpose,
        reference: r.reference,
        chain: r.chain,
        status: r.status,
        pay: `${r.payAmount} ${r.paySymbol}`,
        receive: `${r.receiveAmount} ${r.receiveAsset}`,
        depositAddress: r.depositAddress,
        depositMemo: r.depositMemo,
        refundAddress: r.refundAddress,
        userTxHash: r.userTxHash,
        swapTxHash: r.swapTxHash,
        createdAt: r.createdAt,
        ...describeChainSwap(r),
      })),
    });
  } catch (err) {
    console.error("[chain-swaps]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load payments from other chains" }, { status: 502 });
  }
}
