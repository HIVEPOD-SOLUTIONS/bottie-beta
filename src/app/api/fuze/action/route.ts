import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import {
  acceptTermsAndConditions,
  createGatewayCustomer,
  createGatewayDepositWallet,
  createGatewayPayin,
  createGatewayPayout,
  createGatewayRefund,
  createInternalAccount,
  createInternalWallet,
  createRemittanceBeneficiary,
  createRemittanceOriginator,
  createRemittancePayoutToBeneficiary,
  createRemittanceQuote,
  createTradeOrder,
  createTradeQuote,
  createUser,
  fetchGatewayCustomer,
  fetchGatewayPayin,
  fetchGatewayPayout,
  fetchRemittanceBeneficiary,
  fetchRemittanceOriginator,
  getGatewayAccountBalances,
  getGatewayConversionRate,
  getUser,
  getUserBalance,
  getUserKycLink,
  listGatewayDepositWallets,
  listGatewayPayins,
  listGatewayPayouts,
  listGatewaySupportedAssets,
  listInternalAccounts,
  listInternalWallets,
  listRemittancePayouts,
} from "@/lib/fuze";

const ACTIONS = {
  acceptTermsAndConditions: (payload: { orgUserId: string }) => acceptTermsAndConditions(payload.orgUserId),
  createGatewayCustomer,
  createGatewayDepositWallet,
  createGatewayPayin,
  createGatewayPayout,
  createGatewayRefund,
  createInternalAccount,
  createInternalWallet,
  createRemittanceBeneficiary,
  createRemittanceOriginator,
  createRemittancePayoutToBeneficiary,
  createRemittanceQuote,
  createTradeOrder,
  createTradeQuote,
  createUser,
  fetchGatewayCustomer: (payload: { clientIdentifier: string }) => fetchGatewayCustomer(payload.clientIdentifier),
  fetchGatewayPayin: (payload: { clientOrderId: string }) => fetchGatewayPayin(payload.clientOrderId),
  fetchGatewayPayout: (payload: { clientOrderId: string }) => fetchGatewayPayout(payload.clientOrderId),
  fetchRemittanceBeneficiary: (payload: { clientIdentifier: string }) => fetchRemittanceBeneficiary(payload.clientIdentifier),
  fetchRemittanceOriginator: (payload: { clientIdentifier: string }) => fetchRemittanceOriginator(payload.clientIdentifier),
  getGatewayAccountBalances,
  getGatewayConversionRate,
  getUser: (payload: { orgUserId: string }) => getUser(payload.orgUserId),
  getUserBalance: (payload: { orgUserId: string }) => getUserBalance(payload.orgUserId),
  getUserKycLink: (payload: { orgUserId: string }) => getUserKycLink(payload.orgUserId),
  listGatewayDepositWallets,
  listGatewayPayins,
  listGatewayPayouts,
  listGatewaySupportedAssets,
  listInternalAccounts: (payload: { orgUserId: string }) => listInternalAccounts(payload.orgUserId),
  listInternalWallets: (payload: { orgUserId: string }) => listInternalWallets(payload.orgUserId),
  listRemittancePayouts: (payload: { clientIdentifier: string }) => listRemittancePayouts(payload.clientIdentifier),
} as const;

type ActionName = keyof typeof ACTIONS;

function isActionName(value: unknown): value is ActionName {
  return typeof value === "string" && value in ACTIONS;
}

export async function GET() {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    configured: Boolean(process.env.FUZE_API_KEY && process.env.FUZE_API_SECRET),
    baseUrl: process.env.FUZE_API_BASE ?? "https://preprod.api.fuze.finance",
    actions: Object.keys(ACTIONS),
  });
}

export async function POST(req: NextRequest) {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action?: unknown; payload?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isActionName(body.action)) {
    return NextResponse.json({ error: "Unsupported Fuze action" }, { status: 400 });
  }

  const payload = body.payload ?? {};

  try {
    const result = await (ACTIONS[body.action] as (arg: unknown) => Promise<unknown>)(payload);
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fuze request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
