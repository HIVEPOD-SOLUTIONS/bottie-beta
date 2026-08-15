/**
 * Circle Gateway Nanopayments utilities — Base mainnet.
 *
 * Buyer operations (deposit, pay, withdraw, balance) use GatewayClient with
 * CIRCLE_BUYER_PRIVATE_KEY — appropriate for agent/server-side flows.
 *
 * Seller operations use BatchFacilitatorClient directly, adapted for Next.js
 * route handlers (no Express required).
 */

import {
  CIRCLE_GATEWAY_CHAIN,
  CIRCLE_GATEWAY_FACILITATOR_URL,
  CIRCLE_GATEWAY_NETWORK,
  CIRCLE_BASE_USDC,
  CIRCLE_BASE_GATEWAY_WALLET,
} from "@/lib/constants";

// ── Buyer (agent) ─────────────────────────────────────────────────────────────

export function getBuyerClient() {
  const privateKey = process.env.CIRCLE_BUYER_PRIVATE_KEY;
  if (!privateKey)
    throw new Error("CIRCLE_BUYER_PRIVATE_KEY environment variable is not set");

  // Lazily import to keep server-only code out of client bundles.
  const { GatewayClient } = require("@circle-fin/x402-batching/client");
  return new GatewayClient({
    chain: CIRCLE_GATEWAY_CHAIN,
    privateKey: privateKey as `0x${string}`,
  }) as import("@circle-fin/x402-batching/client").GatewayClient;
}

// ── Seller (facilitator) ──────────────────────────────────────────────────────

export function getFacilitatorClient() {
  const { BatchFacilitatorClient } = require("@circle-fin/x402-batching/server");
  return new BatchFacilitatorClient({
    url: CIRCLE_GATEWAY_FACILITATOR_URL,
  }) as import("@circle-fin/x402-batching/server").BatchFacilitatorClient;
}

/**
 * Build x402 payment requirements for a given price (in USDC base units).
 * The verifyingContract is fetched from the facilitator's supported-kinds list.
 */
export async function buildPaymentRequirements(
  amountUSDC: number,
  sellerAddress: string,
  resourceUrl: string,
) {
  // Use known Base mainnet Gateway Wallet contract address.
  // Can be overridden via CIRCLE_GATEWAY_WALLET_ADDRESS env var.
  const verifyingContract =
    process.env.CIRCLE_GATEWAY_WALLET_ADDRESS ??
    CIRCLE_BASE_GATEWAY_WALLET;

  // USDC has 6 decimals; multiply dollar amount by 1_000_000
  const amountBase = Math.round(amountUSDC * 1_000_000).toString();

  const requirements = {
    scheme: "exact",
    network: CIRCLE_GATEWAY_NETWORK,
    asset: process.env.CIRCLE_USDC_ADDRESS ?? CIRCLE_BASE_USDC,
    amount: amountBase,
    maxTimeoutSeconds: 604900, // 7 days + buffer
    payTo: sellerAddress,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract,
    },
  };

  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: "Paid content via Circle Gateway nanopayments",
      mimeType: "application/json",
    },
    accepts: [requirements],
  };

  return { requirements, paymentRequired };
}

/**
 * Parse and settle a PAYMENT-SIGNATURE header using Circle Gateway.
 * Returns null if settlement fails.
 */
function parsePaymentSignature(header: string): unknown | null {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Verify a payment signature without settling.
 * Call this first — it's fast and confirms the authorization is valid before
 * committing any resources. If valid, serve the content, then settle async.
 */
export async function verifyPayment(
  paymentSignatureHeader: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requirements: any,
): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
  const payload = parsePaymentSignature(paymentSignatureHeader);
  if (!payload) return { isValid: false, invalidReason: "Malformed payment signature" };
  const facilitator = getFacilitatorClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return facilitator.verify(payload as any, requirements);
}

/**
 * Settle a verified payment with Circle Gateway (batch onchain settlement).
 * Call after verify passes and content is served.
 */
export async function settlePayment(
  paymentSignatureHeader: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requirements: any,
): Promise<{ success: boolean; payer?: string; transaction?: string; errorReason?: string }> {
  const payload = parsePaymentSignature(paymentSignatureHeader);
  if (!payload) return { success: false, errorReason: "Malformed payment signature header" };
  const facilitator = getFacilitatorClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return facilitator.settle(payload as any, requirements);
}
