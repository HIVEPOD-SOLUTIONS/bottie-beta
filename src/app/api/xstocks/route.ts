import { NextRequest, NextResponse } from "next/server";
import * as xs from "@/lib/xstocks";
import { verifyAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const { op, ...params } = body;

    let result: unknown;

    switch (op) {
      // ── Public: Assets ──────────────────────────────────────────────────────
      case "listAssets":
        result = await xs.listAssets();
        break;
      case "getAsset":
        result = await xs.getAsset(params.symbol as string);
        break;
      case "getAssetMultiplier":
        result = await xs.getAssetMultiplier(params.symbol as string);
        break;
      case "getAssetMultiplierHistory":
        result = await xs.getAssetMultiplierHistory(params.symbol as string, {
          from: params.from as string | undefined,
          to: params.to as string | undefined,
          limit: params.limit as number | undefined,
        });
        break;
      case "getAssetPriceData":
        result = await xs.getAssetPriceData(params.symbol as string, {
          from: params.from as string | undefined,
          to: params.to as string | undefined,
          interval: params.interval as string | undefined,
        });
        break;
      case "getAssetCirculatingSupply":
        result = await xs.getAssetCirculatingSupply(params.symbol as string);
        break;
      case "getAssetTotalSupply":
        result = await xs.getAssetTotalSupply(params.symbol as string);
        break;
      // ── Public: Proof of Reserves ───────────────────────────────────────────
      case "listProofOfReserves":
        result = await xs.listProofOfReserves();
        break;
      case "getProofOfReserves":
        result = await xs.getProofOfReserves(params.symbol as string);
        break;
      // ── Public: Oracles ─────────────────────────────────────────────────────
      case "listOracles":
        result = await xs.listOracles();
        break;
      case "getOracle":
        result = await xs.getOracle(params.symbol as string);
        break;
      // ── Public: System ──────────────────────────────────────────────────────
      case "getSystemStatus":
        result = await xs.getSystemStatus(params.symbol as string);
        break;
      case "getSystemWallets":
        result = await xs.getSystemWallets();
        break;
      // ── Public: Corporate Actions ───────────────────────────────────────────
      case "getCorporateActionsHistory":
        result = await xs.getCorporateActionsHistory({
          symbol: params.symbol as string | undefined,
          from: params.from as string | undefined,
          to: params.to as string | undefined,
        });
        break;
      case "getCorporateActionsUpcoming":
        result = await xs.getCorporateActionsUpcoming({
          symbol: params.symbol as string | undefined,
        });
        break;
      // ── Public: Bridges ─────────────────────────────────────────────────────
      case "listPublicBridges":
        result = await xs.listPublicBridges();
        break;
      // ── Client ──────────────────────────────────────────────────────────────
      case "getRegisteredWallets":
        result = await xs.getRegisteredWallets();
        break;
      case "getClientLimits":
        result = await xs.getClientLimits();
        break;
      case "getClientUsage":
        result = await xs.getClientUsage();
        break;
      case "createWhitelistChallenge":
        result = await xs.createWhitelistChallenge({
          walletAddress: params.walletAddress as string,
          chain: params.chain as string,
        });
        break;
      case "submitWhitelist":
        result = await xs.submitWhitelist({
          walletAddress: params.walletAddress as string,
          chain: params.chain as string,
          signature: params.signature as string,
          challenge: params.challenge as string,
        });
        break;
      // ── Trades ──────────────────────────────────────────────────────────────
      case "getTradesSummary":
        result = await xs.getTradesSummary();
        break;
      case "listTrades":
        result = await xs.listTrades({
          symbol: params.symbol as string | undefined,
          type: params.type as string | undefined,
          status: params.status as string | undefined,
          from: params.from as string | undefined,
          to: params.to as string | undefined,
          limit: params.limit as number | undefined,
          offset: params.offset as number | undefined,
        });
        break;
      case "getTrade":
        result = await xs.getTrade(params.id as string);
        break;
      // ── xChange ─────────────────────────────────────────────────────────────
      case "createXchangeRfq":
        result = await xs.createXchangeRfq({
          symbol: params.symbol as string,
          side: params.side as "buy" | "sell",
          quantity: params.quantity as number | undefined,
          notional: params.notional as number | undefined,
          walletAddress: params.walletAddress as string | undefined,
          chain: params.chain as string | undefined,
        });
        break;
      case "createXchangeRfqSoft":
        result = await xs.createXchangeRfqSoft({
          symbol: params.symbol as string,
          side: params.side as "buy" | "sell",
          quantity: params.quantity as number | undefined,
          notional: params.notional as number | undefined,
        });
        break;
      case "getXchangeQuote":
        result = await xs.getXchangeQuote(params.id as string);
        break;
      case "listXchangeAssets":
        result = await xs.listXchangeAssets();
        break;
      case "getXchangeAsset":
        result = await xs.getXchangeAsset(params.identifier as string);
        break;
      // ── Market ──────────────────────────────────────────────────────────────
      case "getMarketRedemptionWallets":
        result = await xs.getMarketRedemptionWallets();
        break;
      case "getMarketIssuanceWallets":
        result = await xs.getMarketIssuanceWallets();
        break;
      case "getMarketFees":
        result = await xs.getMarketFees();
        break;
      // ── InKind ──────────────────────────────────────────────────────────────
      case "getInkindSweepingWallets":
        result = await xs.getInkindSweepingWallets();
        break;
      // ── Bridges ─────────────────────────────────────────────────────────────
      case "listBridges":
        result = await xs.listBridges();
        break;
      case "getBridgeSweepingWallets":
        result = await xs.getBridgeSweepingWallets();
        break;
      default:
        return NextResponse.json({ error: `Unknown op: ${op as string}` }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
