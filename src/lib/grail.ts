/**
 * Oro GRAIL API client — gold trading on Solana.
 *
 * Buy/sell flows require THREE signers:
 *   1. GRAIL (server, pre-signed in the returned transaction)
 *   2. Partner (this server, via coSignTransaction)
 *   3. User (frontend, via Privy signTransaction)
 *
 * Redemptions require only GRAIL + user signatures (no partner co-sign).
 *
 * Required env vars:
 *   GRAIL_API_KEY           — grail_partner_<hex>, obtained via challenge-response
 *   GRAIL_PARTNER_PRIVATE_KEY — base58 Solana keypair (partner wallet)
 *   GRAIL_PARTNER_ID        — UUID assigned by ORO at onboarding
 */

import { Transaction, Keypair } from "@solana/web3.js";

export const GRAIL_BASE = "https://grail-stack-dev.onrender.com";

// ── Core fetch ────────────────────────────────────────────────────────────────

function getApiKey() {
  const k = process.env.GRAIL_API_KEY;
  if (!k) throw new Error("GRAIL_API_KEY not configured");
  return k;
}

async function grailFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GRAIL_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: { message?: string; error?: string } = {};
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    throw new Error(parsed.message ?? parsed.error ?? `GRAIL ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  try { return JSON.parse(text) as T; } catch {
    throw new Error(`GRAIL: non-JSON response: ${text.slice(0, 200)}`);
  }
}

// ── Transaction co-signing (partner) ─────────────────────────────────────────

/**
 * Deserialise a GRAIL-pre-signed transaction, add the partner signature,
 * and re-serialise. The user must add the final signature in the browser.
 */
export async function coSignTransaction(partiallySignedB64: string): Promise<string> {
  const { default: bs58 } = await import("bs58");
  const secret = process.env.GRAIL_PARTNER_PRIVATE_KEY;
  if (!secret) throw new Error("GRAIL_PARTNER_PRIVATE_KEY not configured");
  const keypair = Keypair.fromSecretKey(bs58.decode(secret));
  const tx = Transaction.from(Buffer.from(partiallySignedB64, "base64"));
  tx.partialSign(keypair);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function requestChallenge(walletAddress: string) {
  const partnerId = process.env.GRAIL_PARTNER_ID;
  if (!partnerId) throw new Error("GRAIL_PARTNER_ID not configured");
  const res = await fetch(`${GRAIL_BASE}/v1/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet_address: walletAddress, partner_id: partnerId }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GRAIL challenge failed: ${text}`);
  return JSON.parse(text) as { challenge_id: string; message: string; expires_at: string };
}

export async function createApiKey(challengeId: string, signatureB64: string, keyName = "bluvfi") {
  const res = await fetch(`${GRAIL_BASE}/v1/auth/api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge_id: challengeId, signature: signatureB64, key_name: keyName }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GRAIL create API key failed: ${text}`);
  return JSON.parse(text) as { api_key: string; key_id: string; scope: string };
}

// ── Users ─────────────────────────────────────────────────────────────────────

export interface GrailUser {
  grail_user_id: string;
  user_id: string;
  wallet_address: string;
  created_at: string;
  kyc?: { country: string; full_name: string; kyc_level: string; kyc_verified_at: string };
}

export interface CreateGrailUserParams {
  user_id: string;
  wallet_address: string;
  kyc: {
    country: string;
    full_name: string;
    kyc_provider: string;
    kyc_level: "full";
    kyc_verified_at: string;
  };
}

export async function createGrailUser(params: CreateGrailUserParams): Promise<GrailUser> {
  return grailFetch<GrailUser>("/v1/users", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getGrailUser(grailUserId: string): Promise<GrailUser> {
  return grailFetch<GrailUser>(`/v1/users/${grailUserId}`);
}

export async function listGrailUsers(): Promise<{ users: GrailUser[] }> {
  return grailFetch<{ users: GrailUser[] }>("/v1/users");
}

/**
 * Find an existing GRAIL user by wallet address, or create one.
 * Returns { grailUserId, created }.
 * Uses wallet_address as the partner-scoped user_id for idempotency.
 */
export async function findOrCreateGrailUser(params: {
  walletAddress: string;
  fullName: string;
  country?: string;
}): Promise<{ grailUserId: string; created: boolean }> {
  const { walletAddress, fullName, country = "US" } = params;

  try {
    const user = await createGrailUser({
      user_id: walletAddress,
      wallet_address: walletAddress,
      kyc: {
        country,
        full_name: fullName,
        kyc_provider: "manual",
        kyc_level: "full",
        kyc_verified_at: new Date().toISOString(),
      },
    });
    return { grailUserId: user.grail_user_id, created: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("user_already_exists") && !msg.includes("409")) throw err;
    // User already exists — find by wallet_address in the list
    const { users } = await listGrailUsers();
    const existing = users.find(
      (u) => u.wallet_address === walletAddress || u.user_id === walletAddress,
    );
    if (!existing) throw new Error(`GRAIL user not found for wallet ${walletAddress}`);
    return { grailUserId: existing.grail_user_id, created: false };
  }
}

// ── Denominations ─────────────────────────────────────────────────────────────

export interface Denomination {
  id: string;
  label: string;
  weight_g: number;
  weight_troy_oz: number;
  city: string;
}

export async function listDenominations(country: string): Promise<{ denominations: Denomination[] }> {
  return grailFetch<{ denominations: Denomination[] }>(
    `/v1/denominations?country=${encodeURIComponent(country)}`,
  );
}

// ── Trades ────────────────────────────────────────────────────────────────────

export interface TradeQuote {
  usdc_amount: number;
  gold_amount: number;
  price_per_troy_oz: number;
  fee_bps: number;
  fee_usd: number;
  min_gold_out?: number;
  min_usdc_out?: number;
}

export interface TradeQuoteResponse {
  trade_id: string;
  side: "buy" | "sell";
  quote: TradeQuote;
  partially_signed_transaction: string;
}

export interface Trade {
  trade_id: string;
  side: "buy" | "sell";
  status: "confirmed" | "failed" | "pending";
  usdc_amount: number;
  gold_amount: number;
  price_per_troy_oz: number;
  fee_bps: number;
  fee_usd: number;
  submitted_tx_hash?: string;
  created_at: string;
  updated_at: string;
}

/** Quote a gold buy. Partner co-signs on the server; user must add the final signature. */
export async function quoteBuy(
  grailUserId: string,
  usdcAmount: number,
  slippageBps = 50,
): Promise<TradeQuoteResponse & { cosigned_transaction: string }> {
  const result = await grailFetch<TradeQuoteResponse>("/v1/buy", {
    method: "POST",
    body: JSON.stringify({ grail_user_id: grailUserId, usdc_amount: usdcAmount, slippage_bps: slippageBps }),
  });
  const cosigned_transaction = await coSignTransaction(result.partially_signed_transaction);
  return { ...result, cosigned_transaction };
}

export async function submitBuy(tradeId: string, signedTx: string): Promise<{ trade_id: string; tx_hash: string }> {
  return grailFetch<{ trade_id: string; tx_hash: string }>(`/v1/buy/${tradeId}/submit`, {
    method: "POST",
    body: JSON.stringify({ signed_tx: signedTx }),
  });
}

/** Quote a gold sell. Partner co-signs on the server; user must add the final signature. */
export async function quoteSell(
  grailUserId: string,
  goldAmount: number,
  slippageBps = 50,
): Promise<TradeQuoteResponse & { cosigned_transaction: string }> {
  const result = await grailFetch<TradeQuoteResponse>("/v1/sell", {
    method: "POST",
    body: JSON.stringify({ grail_user_id: grailUserId, gold_amount: goldAmount, slippage_bps: slippageBps }),
  });
  const cosigned_transaction = await coSignTransaction(result.partially_signed_transaction);
  return { ...result, cosigned_transaction };
}

export async function submitSell(tradeId: string, signedTx: string): Promise<{ trade_id: string; tx_hash: string }> {
  return grailFetch<{ trade_id: string; tx_hash: string }>(`/v1/sell/${tradeId}/submit`, {
    method: "POST",
    body: JSON.stringify({ signed_tx: signedTx }),
  });
}

export async function getTrade(tradeId: string): Promise<Trade> {
  return grailFetch<Trade>(`/v1/trades/${tradeId}`);
}

export async function listTrades(params: {
  grail_user_id?: string;
  side?: "buy" | "sell";
  status?: string;
  limit?: number;
} = {}): Promise<{ trades: Trade[] }> {
  const qs = new URLSearchParams();
  if (params.grail_user_id) qs.set("grail_user_id", params.grail_user_id);
  if (params.side) qs.set("side", params.side);
  if (params.status) qs.set("status", params.status);
  if (params.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return grailFetch<{ trades: Trade[] }>(`/v1/trades${q ? `?${q}` : ""}`);
}

// ── Redemptions ───────────────────────────────────────────────────────────────

export interface RedemptionQuote {
  denomination: string;
  weight_g: number;
  spot_price_usd: number;
  gold_value_usd: number;
  fee_usd: number;
  total_usd: number;
  tokens_required: string;
}

export interface Redemption {
  redemption_id: string;
  status: string;
  denomination?: string;
  weight_g?: number;
  city?: string;
  quote?: RedemptionQuote;
  partially_signed_transaction?: string;
  submitted_tx_hash?: string;
  cancellation_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Quote a physical gold redemption. Only the user signs (no partner co-sign). */
export async function quoteRedemption(
  grailUserId: string,
  denominationId: string,
  city: string,
): Promise<Redemption> {
  return grailFetch<Redemption>("/v1/redemptions", {
    method: "POST",
    body: JSON.stringify({ grail_user_id: grailUserId, denomination_id: denominationId, city }),
  });
}

export async function submitRedemption(
  redemptionId: string,
  signedTx: string,
): Promise<{ redemption_id: string; tx_hash: string }> {
  return grailFetch<{ redemption_id: string; tx_hash: string }>(
    `/v1/redemptions/${redemptionId}/submit`,
    { method: "POST", body: JSON.stringify({ signed_tx: signedTx }) },
  );
}

export async function getRedemption(redemptionId: string): Promise<Redemption> {
  return grailFetch<Redemption>(`/v1/redemptions/${redemptionId}`);
}

export async function listRedemptions(params: {
  grail_user_id?: string;
  status?: string;
  city?: string;
} = {}): Promise<{ redemptions: Redemption[] }> {
  const qs = new URLSearchParams();
  if (params.grail_user_id) qs.set("grail_user_id", params.grail_user_id);
  if (params.status) qs.set("status", params.status);
  if (params.city) qs.set("city", params.city);
  const q = qs.toString();
  return grailFetch<{ redemptions: Redemption[] }>(`/v1/redemptions${q ? `?${q}` : ""}`);
}

export async function cancelRedemption(
  redemptionId: string,
  reason: string,
): Promise<{ redemption_id: string; status: string }> {
  return grailFetch<{ redemption_id: string; status: string }>(
    `/v1/redemptions/${redemptionId}/cancel`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}
