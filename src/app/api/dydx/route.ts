import { NextRequest, NextResponse } from "next/server";
import * as dydx from "@/lib/dydx";
import { verifyAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { op, ...p } = await req.json();
    let result: unknown;

    switch (op) {
      // Markets
      case "listPerpetualMarkets":
        result = await dydx.listPerpetualMarkets(); break;
      case "getPerpetualMarket":
        result = await dydx.getPerpetualMarket(p.ticker); break;
      case "getOrderbook":
        result = await dydx.getOrderbook(p.ticker); break;
      case "getCandles":
        result = await dydx.getCandles(p.ticker, p.resolution, { limit: p.limit, fromISO: p.fromISO, toISO: p.toISO }); break;
      case "getMarketTrades":
        result = await dydx.getMarketTrades(p.ticker, p.limit); break;
      case "getMarketStats":
        result = await dydx.getMarketStats(p.ticker); break;
      case "getHistoricalFunding":
        result = await dydx.getHistoricalFunding(p.ticker, { limit: p.limit, effectiveBeforeOrAt: p.effectiveBeforeOrAt }); break;
      case "getSparklines":
        result = await dydx.getSparklines(p.timePeriod ?? "ONE_DAY"); break;
      // Account
      case "getAccount":
        result = await dydx.getAccount(p.address); break;
      case "getSubaccount":
        result = await dydx.getSubaccount(p.address, Number(p.subaccountNumber ?? 0)); break;
      case "getPerpetualPositions":
        result = await dydx.getPerpetualPositions(p.address, Number(p.subaccountNumber ?? 0), p.status, p.ticker); break;
      case "getAssetPositions":
        result = await dydx.getAssetPositions(p.address, Number(p.subaccountNumber ?? 0)); break;
      // Orders
      case "getOrders":
        result = await dydx.getOrders(p.address, Number(p.subaccountNumber ?? 0), { status: p.status, ticker: p.ticker, side: p.side, limit: p.limit }); break;
      case "getOrder":
        result = await dydx.getOrder(p.orderId); break;
      case "getFills":
        result = await dydx.getFills(p.address, Number(p.subaccountNumber ?? 0), { ticker: p.ticker, limit: p.limit, createdBeforeOrAt: p.createdBeforeOrAt }); break;
      // History
      case "getTransfers":
        result = await dydx.getTransfers(p.address, Number(p.subaccountNumber ?? 0), { limit: p.limit, createdBeforeOrAt: p.createdBeforeOrAt }); break;
      case "getHistoricalPnl":
        result = await dydx.getHistoricalPnl(p.address, Number(p.subaccountNumber ?? 0), { limit: p.limit, createdBeforeOrAt: p.createdBeforeOrAt }); break;
      case "getFundingPayments":
        result = await dydx.getFundingPayments(p.address, Number(p.subaccountNumber ?? 0), { ticker: p.ticker, limit: p.limit }); break;
      // Rewards
      case "getHistoricalBlockTradingRewards":
        result = await dydx.getHistoricalBlockTradingRewards(p.address, { limit: p.limit, startingBeforeOrAt: p.startingBeforeOrAt }); break;
      case "getHistoricalTradingRewardAggregations":
        result = await dydx.getHistoricalTradingRewardAggregations(p.address, { period: p.period, limit: p.limit, startingBeforeOrAt: p.startingBeforeOrAt }); break;
      // Megavault
      case "getMegavaultPositions":
        result = await dydx.getMegavaultPositions(); break;
      case "getMegavaultHistoricalPnl":
        result = await dydx.getMegavaultHistoricalPnl({ resolution: p.resolution, limit: p.limit }); break;
      case "getMegavaultOwnerShares":
        result = await dydx.getMegavaultOwnerShares(p.address); break;
      case "getMegavaultHistoricalOwnerShares":
        result = await dydx.getMegavaultHistoricalOwnerShares(p.address, { limit: p.limit, createdBeforeOrAt: p.createdBeforeOrAt }); break;
      case "getVaultPositions":
        result = await dydx.getVaultPositions(); break;
      // Chain
      case "getBlockHeight":
        result = await dydx.getBlockHeight(); break;
      case "getServerTime":
        result = await dydx.getServerTime(); break;
      // Parent subaccount
      case "getParentSubaccount":
        result = await dydx.getParentSubaccount(p.address, Number(p.parentSubaccountNumber ?? 0)); break;
      case "getPerpetualPositionsParent":
        result = await dydx.getPerpetualPositionsParent(p.address, Number(p.parentSubaccountNumber ?? 0), { status: p.status, ticker: p.ticker, limit: p.limit }); break;
      case "getAssetPositionsParent":
        result = await dydx.getAssetPositionsParent(p.address, Number(p.parentSubaccountNumber ?? 0)); break;
      case "getOrdersParent":
        result = await dydx.getOrdersParent(p.address, Number(p.parentSubaccountNumber ?? 0), { status: p.status, ticker: p.ticker, side: p.side, limit: p.limit }); break;
      case "getFundingPaymentsParent":
        result = await dydx.getFundingPaymentsParent(p.address, Number(p.parentSubaccountNumber ?? 0), { ticker: p.ticker, limit: p.limit }); break;
      case "getHistoricalPnlParent":
        result = await dydx.getHistoricalPnlParent(p.address, Number(p.parentSubaccountNumber ?? 0), { limit: p.limit, createdBeforeOrAt: p.createdBeforeOrAt }); break;
      case "getTransfersParent":
        result = await dydx.getTransfersParent(p.address, Number(p.parentSubaccountNumber ?? 0), { limit: p.limit, createdBeforeOrAt: p.createdBeforeOrAt }); break;
      // PnL hourly
      case "getPnl":
        result = await dydx.getPnl(p.address, Number(p.subaccountNumber ?? 0), { limit: p.limit, createdBeforeOrAt: p.createdBeforeOrAt }); break;
      case "getPnlParent":
        result = await dydx.getPnlParent(p.address, Number(p.parentSubaccountNumber ?? 0), { limit: p.limit, createdBeforeOrAt: p.createdBeforeOrAt }); break;
      // Trade history
      case "getTradeHistory":
        result = await dydx.getTradeHistory(p.address, Number(p.subaccountNumber ?? 0), { ticker: p.ticker, limit: p.limit }); break;
      case "getTradeHistoryParent":
        result = await dydx.getTradeHistoryParent(p.address, Number(p.parentSubaccountNumber ?? 0), { ticker: p.ticker, limit: p.limit }); break;
      // Transfers between
      case "getTransfersBetween":
        result = await dydx.getTransfersBetween(p.sourceAddress, Number(p.sourceSubaccountNumber ?? 0), p.recipientAddress, Number(p.recipientSubaccountNumber ?? 0)); break;
      // Trader search
      case "searchTrader":
        result = await dydx.searchTrader(p.searchParam); break;
      // Vault historical PnL
      case "getVaultsHistoricalPnl":
        result = await dydx.getVaultsHistoricalPnl({ resolution: p.resolution, limit: p.limit }); break;
      // Compliance
      case "screenAddress":
        result = await dydx.screenAddress(p.address); break;
      case "getComplianceScreen":
        result = await dydx.getComplianceScreen(p.address); break;
      // Affiliates
      case "getAffiliateMetadata":
        result = await dydx.getAffiliateMetadata(p.address); break;
      case "getAffiliateAddressByReferralCode":
        result = await dydx.getAffiliateAddressByReferralCode(p.referralCode); break;
      case "getAffiliatesSnapshot":
        result = await dydx.getAffiliatesSnapshot({ limit: p.limit, offset: p.offset, sortByAffiliateEarning: p.sortByAffiliateEarning }); break;
      default:
        return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
    }

    return NextResponse.json({ result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

