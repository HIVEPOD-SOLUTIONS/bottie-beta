import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import {
  acknowledgeDomaEvents,
  cancelDomaListing,
  cancelDomaOffer,
  completeDomaEmailVerification,
  createDomaBulkListings,
  createDomaBulkOffers,
  createDomaListing,
  createDomaOffer,
  generateDomaMetadata,
  getDomaConfig,
  getDomaBulkListingItems,
  getDomaBulkOfferItems,
  getDomaCommand,
  getDomaFractionalizationInfo,
  getDomaLifecycleWorkflows,
  getDomaListingFulfillment,
  getDomaListings,
  getDomaName,
  getDomaNameActivities,
  getDomaNameStatistics,
  getDomaNetworkInfo,
  getDomaOffers,
  getDomaOfferFulfillment,
  getDomaOrderbookFees,
  getDomaSupportedTlds,
  getDomaSupportedCurrencies,
  getDomaToken,
  getDomaTokenActivities,
  getDomaTokens,
  initiateDomaEmailVerification,
  pollDomaEvents,
  resetDomaEventCursor,
  searchDomaNames,
  uploadDomaRegistrantContacts,
  uploadDomaVerifiedRegistrantContacts,
} from "@/lib/doma";

const ACTIONS = {
  acknowledgeEvents: acknowledgeDomaEvents,
  cancelListing: cancelDomaListing,
  cancelOffer: cancelDomaOffer,
  completeEmailVerification: completeDomaEmailVerification,
  createBulkListings: createDomaBulkListings,
  createBulkOffers: createDomaBulkOffers,
  createListing: createDomaListing,
  createOffer: createDomaOffer,
  generateMetadata: (payload: { tokens: Parameters<typeof generateDomaMetadata>[0] }) => generateDomaMetadata(payload.tokens),
  getConfig: () => getDomaConfig(),
  getBulkListingItems: (payload: { id: string }) => getDomaBulkListingItems(payload.id),
  getBulkOfferItems: (payload: { id: string }) => getDomaBulkOfferItems(payload.id),
  getCommand: (payload: { correlationId: string }) => getDomaCommand(payload.correlationId),
  getFractionalizationInfo: () => getDomaFractionalizationInfo(),
  getLifecycleWorkflows: () => getDomaLifecycleWorkflows(),
  getListingFulfillment: getDomaListingFulfillment,
  getListings: getDomaListings,
  getName: (payload: { name: string }) => getDomaName(payload.name),
  getNameActivities: getDomaNameActivities,
  getNameStatistics: (payload: { tokenId: string }) => getDomaNameStatistics(payload.tokenId),
  getNetworkInfo: () => getDomaNetworkInfo(),
  getOffers: getDomaOffers,
  getOfferFulfillment: getDomaOfferFulfillment,
  getOrderbookFees: getDomaOrderbookFees,
  getSupportedTlds: (payload: { query?: string }) => getDomaSupportedTlds(payload.query),
  getSupportedCurrencies: getDomaSupportedCurrencies,
  getToken: (payload: { tokenId: string }) => getDomaToken(payload.tokenId),
  getTokenActivities: getDomaTokenActivities,
  getTokens: (payload: { name: string; skip?: number; take?: number }) => getDomaTokens(payload.name, payload.skip, payload.take),
  initiateEmailVerification: (payload: { email: string }) => initiateDomaEmailVerification(payload.email),
  pollEvents: pollDomaEvents,
  resetEventCursor: resetDomaEventCursor,
  searchNames: searchDomaNames,
  uploadRegistrantContacts: uploadDomaRegistrantContacts,
  uploadVerifiedRegistrantContacts: uploadDomaVerifiedRegistrantContacts,
} as const;

type DomaAction = keyof typeof ACTIONS;

function isDomaAction(value: unknown): value is DomaAction {
  return typeof value === "string" && value in ACTIONS;
}

export async function GET() {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    ...getDomaConfig(),
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

  if (!isDomaAction(body.action)) {
    return NextResponse.json({ error: "Unsupported Doma action" }, { status: 400 });
  }

  try {
    const result = await (ACTIONS[body.action] as (payload: unknown) => unknown)(body.payload ?? {});
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Doma request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
