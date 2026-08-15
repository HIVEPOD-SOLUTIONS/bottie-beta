/**
 * POST /api/x402/consume
 *
 * Universal 402-payment consumer for the AI agent.
 *
 * Body:
 *   url          string   — fully-qualified or app-relative URL to fetch
 *   method?      "GET"|"POST"  — default GET
 *   body?        object   — POST body forwarded to the protected resource
 *   maxPriceUsd? number   — price cap in USD (default $0.002)
 *   networks?    string[] — CAIP-2 network allowlist (default: all supported)
 *
 * Returns:
 *   { receipt: ConsumeReceipt, result: any, status: number }
 */

import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import {
  consume402,
  ALLOWED_NETWORKS,
  DEFAULT_MAX_PRICE_USD,
} from "@/lib/x402-consumer";

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: {
    url?: string;
    method?: string;
    body?: Record<string, unknown>;
    maxPriceUsd?: number;
    networks?: string[];
  };

  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { url, method, body: resourceBody, maxPriceUsd, networks } = body;

  if (!url || typeof url !== "string") {
    return Response.json({ error: "url is required" }, { status: 422 });
  }

  if (method && method !== "GET" && method !== "POST") {
    return Response.json(
      { error: "method must be GET or POST" },
      { status: 422 },
    );
  }

  if (maxPriceUsd !== undefined && (typeof maxPriceUsd !== "number" || maxPriceUsd <= 0)) {
    return Response.json(
      { error: "maxPriceUsd must be a positive number" },
      { status: 422 },
    );
  }

  // Build network allowlist — validate each CAIP-2 string
  let allowedNetworks = ALLOWED_NETWORKS;
  if (Array.isArray(networks) && networks.length > 0) {
    const invalid = networks.filter((n) => !ALLOWED_NETWORKS.has(n));
    if (invalid.length > 0) {
      return Response.json(
        {
          error: `Unsupported networks: ${invalid.join(", ")}. Supported: ${[...ALLOWED_NETWORKS].join(", ")}`,
        },
        { status: 422 },
      );
    }
    allowedNetworks = new Set(networks);
  }

  try {
    const result = await consume402({
      url,
      method: (method ?? "GET") as "GET" | "POST",
      body: resourceBody,
      maxPriceUsd: maxPriceUsd ?? DEFAULT_MAX_PRICE_USD,
      allowedNetworks,
    });

    // Persist the payment to the DB
    const receipt = (result as any)?.receipt;
    // receipt.amountUSDC is already in human-readable USD (e.g. 0.002)
    const paidUsdc = receipt?.amountUSDC != null
      ? Number(receipt.amountUSDC)
      : (maxPriceUsd ?? DEFAULT_MAX_PRICE_USD);
    const chain = receipt?.network?.startsWith("solana:") ? "solana" : "evm";

    db.insert(payments).values({
      userId,
      type: "x402",
      referenceId: receipt?.txHash ?? receipt?.transaction ?? null,
      description: `x402 payment: ${url}`,
      amountUsdc: paidUsdc.toFixed(6),
      status: "completed",
      txHash: receipt?.txHash ?? receipt?.transaction ?? null,
      chain,
    }).catch(() => {});

    return Response.json(result);
  } catch (err: unknown) {
    const message = (err as Error)?.message ?? "consume402 failed";
    const isValidation =
      message.includes("No acceptable offer") ||
      message.includes("no parseable offers") ||
      message.includes("PAYMENT-REQUIRED header");
    return Response.json(
      { error: message },
      { status: isValidation ? 422 : 502 },
    );
  }
}
