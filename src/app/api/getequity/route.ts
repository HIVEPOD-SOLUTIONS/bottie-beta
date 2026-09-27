import { NextRequest, NextResponse } from "next/server";
import * as ge from "@/lib/getequity";
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
      // ── Market data ──────────────────────────────────────────────────────────
      case "listTokens":
        result = await ge.listTokens(params as any);
        break;
      case "listRaisingTokens":
        result = await ge.listRaisingTokens(params as any);
        break;
      case "searchTokens":
        result = await ge.searchTokens(params as any);
        break;
      case "getToken":
        result = await ge.getToken(params.tokenId as string);
        break;
      case "getAsset":
        result = await ge.getAsset(params.assetId as string);
        break;
      case "getTokenHistoricals":
        result = await ge.getTokenHistoricals(params.tokenId as string, params as any);
        break;
      case "getOfferingBook":
        result = await ge.getOfferingBook(params.tokenId as string, params as any);
        break;
      case "getTransaction":
        result = await ge.getTransaction(params.reference as string, params.transactionId as string | undefined);
        break;

      // ── Members: provisioning ───────────────────────────────────────────────
      case "createMember":
        result = await ge.createMember(params as any);
        break;
      case "getMembers":
        result = await ge.getMembers();
        break;
      case "getMemberByEmail":
        result = await ge.getMemberByEmail(params.email as string);
        break;

      // ── Members: reporting ───────────────────────────────────────────────────
      case "getMemberBalance":
        result = await ge.getMemberBalance(params.memberId as string);
        break;
      case "getMemberTokenBalance":
        result = await ge.getMemberTokenBalance(params.memberId as string);
        break;
      case "getMemberOrders":
        result = await ge.getMemberOrders(params.memberId as string, params as any);
        break;
      case "getMemberTransactions":
        result = await ge.getMemberTransactions(params.memberId as string, params as any);
        break;

      // ── Members: investing (moves real money) ───────────────────────────────
      case "buyTokenAsMember":
        result = await ge.buyTokenAsMember(params.memberId as string, params.tokenId as string, params as any);
        break;
      case "sellTokenAsMember":
        result = await ge.sellTokenAsMember(params.memberId as string, params.tokenId as string, params as any);
        break;
      case "getFundInvestQuote":
        result = await ge.getFundInvestQuote(params.memberId as string, params.tokenId as string, params as any);
        break;
      case "fundInvest":
        result = await ge.fundInvest(params.memberId as string, params.tokenId as string, params as any);
        break;
      case "commitToOfferingAsMember":
        result = await ge.commitToOfferingAsMember(params.memberId as string, params.tokenId as string, params as any);
        break;
      case "cancelMemberOrder":
        result = await ge.cancelMemberOrder(params.memberId as string, params.orderId as string);
        break;

      // ── Members: funding & withdrawals (moves real money) ────────────────────
      case "fundMemberWallet":
        result = await ge.fundMemberWallet(params.memberId as string, params as any);
        break;
      case "withdrawMemberWallet":
        result = await ge.withdrawMemberWallet(params.memberId as string, params as any);
        break;

      case "getConfig":
        result = ge.getGetEquityConfig();
        break;

      default:
        return NextResponse.json({ error: `Unknown op "${op}"` }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
