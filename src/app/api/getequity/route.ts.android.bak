import { NextRequest, NextResponse } from "next/server";
import * as ge from "@/lib/getequity";
import { verifyAuth } from "@/lib/auth";
import { ensureGetEquityMember, getCachedGetEquityMemberId } from "@/lib/getequity-members";

/**
 * Every member-scoped op below is strictly scoped to the calling user's own GetEquity account.
 * There is no `memberId` accepted from the request body — accepting a client-supplied id would
 * let any authenticated Bluvfi user read or act on ANY other member's cash and holdings (the
 * organisation secret key authorizes every member, so nothing else stops that). The member id
 * always comes from this user's own row in getequity_members, never from the request.
 */
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = (await verifyAuth()).userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  async function myMemberId(): Promise<string> {
    const cached = await getCachedGetEquityMemberId(userId);
    if (!cached) throw new Error("No GetEquity account yet for this user — use Create member first.");
    return cached;
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const { op, ...params } = body;

    let result: unknown;

    switch (op) {
      // ── Market data (shared, not user-specific) ─────────────────────────────
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

      // ── My account ───────────────────────────────────────────────────────────
      // Idempotent — creates this user's member if they don't have one yet (password is
      // generated and discarded automatically), or returns their existing one.
      case "createMember":
      case "ensureMember":
        result = await ensureGetEquityMember(userId, params as any);
        break;
      case "getMemberBalance":
        result = await ge.getMemberBalance(await myMemberId());
        break;
      case "getMemberTokenBalance":
        result = await ge.getMemberTokenBalance(await myMemberId());
        break;
      case "getMemberOrders":
        result = await ge.getMemberOrders(await myMemberId(), params as any);
        break;
      case "getMemberTransactions":
        result = await ge.getMemberTransactions(await myMemberId(), params as any);
        break;

      // ── My investing (moves real money) ─────────────────────────────────────
      case "buyTokenAsMember":
        result = await ge.buyTokenAsMember(await myMemberId(), params.tokenId as string, params as any);
        break;
      case "sellTokenAsMember":
        result = await ge.sellTokenAsMember(await myMemberId(), params.tokenId as string, params as any);
        break;
      case "getFundInvestQuote":
        result = await ge.getFundInvestQuote(await myMemberId(), params.tokenId as string, params as any);
        break;
      case "fundInvest":
        result = await ge.fundInvest(await myMemberId(), params.tokenId as string, params as any);
        break;
      case "commitToOfferingAsMember":
        result = await ge.commitToOfferingAsMember(await myMemberId(), params.tokenId as string, params as any);
        break;
      case "cancelMemberOrder":
        result = await ge.cancelMemberOrder(await myMemberId(), params.orderId as string);
        break;

      // ── My funding & withdrawals (moves real money) ──────────────────────────
      case "fundMemberWallet":
        result = await ge.fundMemberWallet(await myMemberId(), params as any);
        break;
      case "withdrawMemberWallet":
        result = await ge.withdrawMemberWallet(await myMemberId(), params as any);
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
