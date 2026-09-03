/**
 * bluvfi-xrpl service client — server-side only.
 *
 * Wrapper around Bluvfi's own internal XRPL wallet/swap service (a separate
 * deployment at BLUVFI_XRPL_API_URL, not a public API). Every field/shape
 * below is confirmed against C:/Users/XPS/bluvfi-xrpl directly — its
 * API_DOCUMENTATION.md, its Zod validation schemas
 * (src/schemas/xrpl.schemas.ts), its NEAR Intents response types
 * (src/lib/nearIntents.ts), and live test calls against a running instance
 * on 2026-08-31 (wallet-requests create, idempotent replay, and
 * service-confirmation all verified live; /quote itself is currently
 * returning a 502 from a genuine NEAR Intents-side "Internal server error"
 * — confirmed via direct testing, not something in this client's control —
 * so amountIn's exact numeric behavior in production is inferred from
 * bluvfi-xrpl's own source comments, not independently re-verified here).
 *
 * Auth: every call sends `x-api-key: BLUVFI_XRPL_API_KEY`.
 */

const BASE = (process.env.BLUVFI_XRPL_API_URL ?? "").replace(/\/$/, "");

function authHeaders(): Record<string, string> {
  const key = process.env.BLUVFI_XRPL_API_KEY;
  if (!key) throw new Error("BLUVFI_XRPL_API_KEY is not set");
  if (!BASE) throw new Error("BLUVFI_XRPL_API_URL is not set");
  return {
    "x-api-key": key,
    "Content-Type": "application/json",
  };
}

export function isXrplBackendConfigured(): boolean {
  return Boolean(process.env.BLUVFI_XRPL_API_URL && process.env.BLUVFI_XRPL_API_KEY);
}

async function request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`bluvfi-xrpl ${method} ${path} → ${res.status}: ${text}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`bluvfi-xrpl: non-JSON response from ${path}: ${text.slice(0, 200)}`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
// Field names/types below match the live response exactly (verified 2026-08-31):
// {"message":"...","user":{...},"wallet":{ id, address, sourceTag, status,
//  expectedAmount, requiredActivationDrops, requiredActivationXrp (number),
//  network, createdAt, activatedAt, readyAt, errorMessage, swapStatus,
//  swapDestinationAsset, swapRecipient, swapAmountDrops, swapMinAmountOut,
//  swapExpiresAt, swapDepositAddress, swapTxHash, swapCompletedAt,
//  swapErrorMessage, serviceConfirmationStatus, serviceConfirmedAt,
//  serviceConfirmationDetails, serviceConfirmationError, idempotencyKey },
//  "idempotentReplay"?: boolean}

export type XrplWalletStatus = "AWAITING_ACTIVATION" | "READY" | "FAILED";
export type XrplSwapStatus =
  | "NOT_APPLICABLE" | "PENDING" | "QUOTE_REQUESTED" | "DEPOSIT_SUBMITTED"
  | "PROCESSING" | "COMPLETED" | "REFUNDED" | "EXPIRED" | "FAILED";
export type XrplServiceConfirmationStatus = "NOT_APPLICABLE" | "CONFIRMED" | "FAILED";

export interface XrplWallet {
  id: string;
  address: string;
  sourceTag: number;
  status: XrplWalletStatus;
  expectedAmount: string | null;
  requiredActivationDrops: string;
  /** Note: a number, not a string, in the live response */
  requiredActivationXrp: number;
  network: string;
  createdAt: string;
  activatedAt: string | null;
  readyAt: string | null;
  errorMessage: string | null;
  swapStatus: XrplSwapStatus;
  swapDestinationAsset: string | null;
  swapRecipient: string | null;
  /** Drops (1 XRP = 1,000,000 drops) */
  swapAmountDrops: string | null;
  swapMinAmountOut: string | null;
  swapExpiresAt: string | null;
  swapDepositAddress: string | null;
  swapTxHash: string | null;
  swapCompletedAt: string | null;
  swapErrorMessage: string | null;
  serviceConfirmationStatus: XrplServiceConfirmationStatus;
  serviceConfirmedAt: string | null;
  serviceConfirmationDetails: Record<string, unknown> | null;
  serviceConfirmationError: string | null;
  idempotencyKey?: string | null;
  /**
   * Nested under `wallet`, NOT top-level on the response — confirmed by a
   * live call (2026-08-31): {"message","user","wallet":{...,"idempotentReplay":true}}.
   * A prior version of this client read it from the wrong place
   * (top-level `res.idempotentReplay`, which never exists), silently
   * returning `undefined` from every createWalletRequest() call regardless
   * of whether it was a fresh wallet or a replay. Fixed here.
   */
  idempotentReplay?: boolean;
}

export interface XrplUser {
  id: string;
  privyDid: string;
  email: string | null;
}

export interface WalletRequestResponse {
  message: string;
  user: XrplUser;
  wallet: XrplWallet; // idempotentReplay lives here, not at this top level
}

export interface CreateWalletRequestParams {
  privyDid: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  /** Informational only — not enforced on-chain */
  expectedAmount?: string;
  metadata?: Record<string, unknown>;
  /** Safe to call repeatedly with the same (privyDid, idempotencyKey) pair */
  idempotencyKey?: string;
  /** Decimal XRP string, e.g. "2.5" — required together with swapRecipient */
  swapAmountXrp?: string;
  /** Destination-chain address the calling app controls */
  swapRecipient?: string;
  /** NEAR Intents assetId, e.g. "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" — defaults to USDC on Solana if omitted */
  swapDestinationAsset?: string;
  /** Whole-number string, smallest unit of swapDestinationAsset (e.g. USDC's 6 decimals) */
  swapMinAmountOut?: string;
  /** Relative seconds, max 86400 — deadline for *initiating* the swap */
  swapExpiresInSeconds?: number;
}

/**
 * Create (or, with a repeated idempotencyKey, return the existing) wallet
 * request. `idempotentReplay` (on the returned wallet) is `true` for a
 * repeated call with the same (privyDid, idempotencyKey) pair, `false` for
 * a genuinely fresh wallet, and absent entirely if no idempotencyKey was
 * supplied at all — matches bluvfi-xrpl's response exactly, confirmed live.
 */
export async function createWalletRequest(
  params: CreateWalletRequestParams,
): Promise<XrplWallet> {
  const res = await request<WalletRequestResponse>(
    "POST",
    "/api/xrpl/wallet-requests",
    params as unknown as Record<string, unknown>,
  );
  return res.wallet;
}

export async function getWalletRequest(id: string): Promise<XrplWallet & { activities: unknown[] }> {
  const res = await request<{ wallet: XrplWallet & { activities: unknown[] } }>(
    "GET",
    `/api/xrpl/wallet-requests/${encodeURIComponent(id)}`,
  );
  return res.wallet;
}

/** Forces an immediate ledger re-check instead of waiting for the next reconciliation sweep (~30s). */
export async function recheckWalletRequest(id: string): Promise<XrplWallet> {
  const res = await request<{ wallet: XrplWallet }>(
    "POST",
    `/api/xrpl/wallet-requests/${encodeURIComponent(id)}/recheck`,
  );
  return res.wallet;
}

// ── Quotes ────────────────────────────────────────────────────────────────────
// Response shape confirmed from bluvfi-xrpl's own nearIntents.ts QuoteResponse
// type (backed by live-verified examples in its source comments):
//   EXACT_OUTPUT, 3 USDC out -> amountIn: "2350413" (drops), minAmountIn: "2326908"
// amountIn/minAmountIn are populated for EXACT_OUTPUT; amountOut/minAmountOut
// for EXACT_INPUT. *Formatted variants (if present) are human-decimal strings.

export interface GetQuoteParams {
  swapType: "EXACT_OUTPUT" | "EXACT_INPUT";
  /** Whole-number string: drops for EXACT_INPUT, destinationAsset's smallest unit for EXACT_OUTPUT */
  amount: string;
  destinationAsset?: string;
  recipient: string;
  /** Optional but strongly recommended — see rate-limit note in API_DOCUMENTATION.md */
  privyDid?: string;
}

export interface QuoteResult {
  quote: {
    depositAddress?: string;
    depositMemo?: string;
    amountOut: string;
    amountOutFormatted: string;
    minAmountOut?: string;
    minAmountOutFormatted?: string;
    /** Drops of XRP — populated for EXACT_OUTPUT ("the estimated XRP required") */
    amountIn?: string;
    amountInFormatted?: string;
    minAmountIn?: string;
    minAmountInFormatted?: string;
    [key: string]: unknown;
  };
  quoteRequest: Record<string, unknown>;
  signature: string;
  timestamp: string;
  correlationId: string;
}

export async function getQuote(params: GetQuoteParams): Promise<QuoteResult> {
  return request<QuoteResult>("POST", "/api/xrpl/quote", params as unknown as Record<string, unknown>);
}

// ── Service confirmation ──────────────────────────────────────────────────────

export type ServiceConfirmationStatus = "CONFIRMED" | "FAILED";

export async function reportServiceConfirmation(
  walletRequestId: string,
  status: ServiceConfirmationStatus,
  details?: Record<string, unknown>,
  /** Required by bluvfi-xrpl when status is "FAILED" */
  errorMessage?: string,
): Promise<XrplWallet> {
  const res = await request<{ message: string; wallet: XrplWallet }>(
    "POST",
    `/api/xrpl/wallet-requests/${encodeURIComponent(walletRequestId)}/service-confirmation`,
    { status, ...(details ? { details } : {}), ...(errorMessage ? { errorMessage } : {}) },
  );
  return res.wallet;
}

// ── Sidebar-to-purchase transfer ──────────────────────────────────────────────

export interface TransferResult {
  message: string;
  txHash: string;
  amountDrops: string;
  // Both built server-side via getWalletRequestById(), which always attaches
  // the full activity history — typed here so a caller can use the transfer
  // response directly instead of a follow-up GET if it ever needs the trail.
  source: XrplWallet & { activities: unknown[] };
  destination: XrplWallet & { activities: unknown[] };
}

/**
 * Moves XRP from the wallet in the URL (`sourceWalletRequestId`) to another
 * wallet this backend holds. Both must be existing wallet-request ids owned
 * by the same user — bluvfi-xrpl rejects a free-form address or a
 * mismatched-owner pair outright, this client just proxies the call.
 */
export async function transferBetweenWallets(
  sourceWalletRequestId: string,
  destinationWalletRequestId: string,
  amountXrp: string,
): Promise<TransferResult> {
  return request<TransferResult>(
    "POST",
    `/api/xrpl/wallet-requests/${encodeURIComponent(sourceWalletRequestId)}/transfer`,
    { destinationWalletRequestId, amountXrp },
  );
}

// ── Activity history ─────────────────────────────────────────────────────────

export interface XrplActivity {
  id: string;
  walletRequestId: string;
  userId: string;
  type: string;
  status: string;
  txHash: string | null;
  amountDrops: string | null;
  sourceTagSeen: number | null;
  metadata: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
}

export async function listUserActivities(userId: string): Promise<XrplActivity[]> {
  const res = await request<{ userId: string; activities: XrplActivity[] }>(
    "GET",
    `/api/xrpl/users/${encodeURIComponent(userId)}/activities`,
  );
  return res.activities;
}
