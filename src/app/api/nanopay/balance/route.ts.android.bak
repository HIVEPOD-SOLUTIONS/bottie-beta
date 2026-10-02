import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { getBuyerClient } from "@/lib/circle-gateway";

export async function GET() {
  try {
    await verifyAuth();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const client = getBuyerClient();
    const balances = await client.getBalances();
    return NextResponse.json({
      address: client.address,
      wallet: {
        usdc: balances.wallet.formatted,
      },
      gateway: {
        available: balances.gateway.formattedAvailable,
        total: balances.gateway.formattedTotal,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Failed to fetch balances" },
      { status: 500 },
    );
  }
}
