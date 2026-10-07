import { createHash } from "node:crypto";
import { USDC_MINT } from "@/lib/payments-rules";

/**
 * x402 (v2) for outside agents calling a paid provider with a wallet instead of a Bluvfi account. Pure functions and constants:
 * no database, no network. The flow lives in x402-edge.ts.
 *
 * Wire format (x402 v2, "exact" scheme on Solana):
 *   1. The agent POSTs with no payment      -> 402 + PAYMENT-REQUIRED header (base64 JSON) listing what to pay.
 *   2. The agent signs a USDC transfer to the pay-to address (the facilitator is the fee payer) and POSTs again with the
 *      PAYMENT-SIGNATURE header (base64 JSON of the payment payload).
 *   3. We verify it, call the provider, and only then settle it. The answer comes back with a PAYMENT-RESPONSE header.
 */

export const X402_VERSION = 2;

export const X402_NETWORKS = {
  mainnet: { caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", usdc: USDC_MINT },
  // Circle's devnet USDC (free from faucet.circle.com): lets the whole flow be tried without real money.
  devnet: { caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
} as const;
export type X402NetworkName = keyof typeof X402_NETWORKS;

export const X402 = {
  /** How long a signed payment stays valid (the transaction's blockhash expires about this soon anyway). */
  maxTimeoutSeconds: 60,
  /** The largest payment header we will even decode. A Solana transaction is at most 1232 bytes. */
  maxHeaderChars: 8_000,
  maxTransactionChars: 4_000,
  /** Verifying/calling for longer than this means the process died before settling: the payment can be presented again. */
  staleMs: 2 * 60_000,
  /** A payment left in "settling" longer than this needs an admin to check it on-chain. */
  stuckMs: 5 * 60_000,
} as const;

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}
export interface PaymentPayload {
  x402Version: number;
  resource?: unknown;
  accepted: PaymentRequirements;
  payload: { transaction: string; [k: string]: unknown };
  extensions?: unknown;
}

export interface X402Config {
  facilitatorUrl: string;
  payTo: string;
  network: X402NetworkName;
  /** Overrides the fee payer the facilitator advertises. Normally left unset. */
  feePayer?: string;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Reads the settings from the environment. Null (switched off) unless a facilitator URL and a pay-to address are both valid. */
export function loadX402Config(get: (name: string) => string | undefined): X402Config | null {
  const url = (get("X402_FACILITATOR_URL") ?? "").trim().replace(/\/+$/, "");
  const payTo = (get("X402_PAY_TO") ?? get("CREDITS_DEPOSIT_ADDRESS") ?? "").trim();
  const network: X402NetworkName = (get("X402_NETWORK") ?? "").trim().toLowerCase() === "devnet" ? "devnet" : "mainnet";
  const feePayer = (get("X402_FEE_PAYER") ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !local) return null;
  if (!BASE58_ADDRESS.test(payTo)) return null;
  if (feePayer && !BASE58_ADDRESS.test(feePayer)) return null;
  return { facilitatorUrl: url, payTo, network, ...(feePayer ? { feePayer } : {}) };
}

export function buildRequirements(cfg: Pick<X402Config, "payTo" | "network">, priceMicro: number, feePayer: string): PaymentRequirements {
  const net = X402_NETWORKS[cfg.network];
  return {
    scheme: "exact",
    network: net.caip2,
    asset: net.usdc,
    amount: String(priceMicro),
    payTo: cfg.payTo,
    maxTimeoutSeconds: X402.maxTimeoutSeconds,
    extra: { feePayer },
  };
}

export function buildPaymentRequired(url: string, description: string, requirements: PaymentRequirements, error?: string): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: { url, description, mimeType: "application/json" },
    accepts: [requirements],
  };
}

export const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type DecodedPayment = { ok: true; payment: PaymentPayload } | { ok: false; error: string };

/** Decodes and shape-checks the payment header. Nothing in it is trusted yet: the requirements are rebuilt on our side. */
export function decodePaymentHeader(header: string | null | undefined): DecodedPayment {
  if (!header || header.length > X402.maxHeaderChars) return { ok: false, error: "invalid_payment_header" };
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, error: "invalid_payment_header" };
  }
  if (!isObject(data) || data.x402Version !== X402_VERSION) return { ok: false, error: "unsupported_x402_version" };
  const { accepted, payload } = data;
  if (!isObject(accepted) || !isObject(payload)) return { ok: false, error: "invalid_payment_header" };
  if (typeof payload.transaction !== "string" || payload.transaction.length === 0 || payload.transaction.length > X402.maxTransactionChars) {
    return { ok: false, error: "invalid_payment_payload" };
  }
  return { ok: true, payment: data as unknown as PaymentPayload };
}

/** The agent says what it agreed to pay. It must be exactly what we asked for, never merely close. */
export function requirementsMatch(accepted: PaymentRequirements, expected: PaymentRequirements): boolean {
  const extra = isObject(accepted.extra) ? accepted.extra : {};
  return (
    accepted.scheme === expected.scheme &&
    accepted.network === expected.network &&
    accepted.asset === expected.asset &&
    String(accepted.amount) === expected.amount &&
    accepted.payTo === expected.payTo &&
    Number(accepted.maxTimeoutSeconds) === expected.maxTimeoutSeconds &&
    extra.feePayer === expected.extra.feePayer
  );
}

/** What makes a payment unique: the same signed transaction presented twice hashes the same. */
export const paymentHash = (payment: PaymentPayload): string => createHash("sha256").update(payment.payload.transaction).digest("hex");

/** Agents have no Bluvfi account: they are identified by the wallet that paid. */
export const x402Caller = (payer: string): string => `x402:${payer}`;
