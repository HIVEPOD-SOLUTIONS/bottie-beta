import { createHash, webcrypto } from "node:crypto";
import { getServerEnv } from "@/lib/server-env";

/**
 * Server-side Cryptorefills client — gift cards, mobile top-ups and eSIMs.
 *
 * Two ways to pay:
 *
 * 1. x402 (gasless USDC, no account or key). The user's Privy wallet signs in
 *    the browser; this module only proxies and verifies.
 *      Base:   an EIP-3009 transferWithAuthorization — Cryptorefills relays it.
 *      Solana: a partially-signed v0 USDC transfer — CDP pays the SOL fee.
 *    Flow (one host for both phases — payment sessions are host-affine):
 *      GET  /v1/brands, /v1/catalog, /v1/price  — free discovery
 *      POST /v1/orders                          — Phase 1: 402 + PAYMENT-REQUIRED
 *      POST /v1/orders + PAYMENT-SIGNATURE      — Phase 2: 200 + order receipt
 *      GET  /v1/orders/{id}                     — poll for the voucher
 *    Phase 1 creates a real (unpaid) order upstream, so only call it when the
 *    user has actually tapped Pay.
 *
 * 2. Partner API (~25 other coins on 20+ chains). Cryptorefills returns a
 *    deposit address the user sends to, so the user pays network gas. Needs
 *    CRYPTOREFILLS_PARTNER_ID (created with any cryptorefills.com account).
 */

export const CR_HOST = "https://x402.cryptorefills.com";
export const CR_PARTNER_HOST = "https://api.cryptorefills.com";

export type CrRail = "base" | "solana";

export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const RAILS: Record<CrRail, { network: string; asset: string }> = {
  base: { network: BASE_NETWORK, asset: BASE_USDC },
  solana: { network: SOLANA_NETWORK, asset: SOLANA_USDC },
};

export interface CrBrand {
  brand_name: string;
  family: string;
  category: string;
  min?: string;
  max?: string;
  /** Official logo (300x190 webp) and its brand background, joined from the public catalogue API. */
  logo_url?: string;
  bg_color?: string;
}

export interface CrCatalogItem {
  product_id: string;
  product_name?: string;
  brand_name: string;
  denomination?: string;
  denomination_label?: string;
  currency?: string;
  is_range: boolean;
  /** Face value in `currency` units, despite the name (NGN products report NGN here). */
  face_value_usd?: number;
  /** Indicative USDC price for fixed products; literal "variable" for ranges. */
  price_usdc: string;
  country_code: string;
  type?: string;
  min_value?: number;
  max_value?: number;
}

export interface CrPriceQuote {
  product_id: string;
  product_name?: string;
  brand_name: string;
  is_range: boolean;
  face_value?: number | string;
  currency: string;
  price_usdc: string;
  min_value?: number | string;
  max_value?: number | string;
  quote_expires_at: string;
}

export interface CrOrderItem {
  beneficiary_account: string;
  product_id?: string;
  brand_name?: string;
  denomination?: string;
  country_code?: string;
  product_value?: number;
}

export interface CrOrderRequest {
  email: string;
  items: CrOrderItem[];
}

/** The accepts[] entry of the decoded PAYMENT-REQUIRED header for the chosen rail. */
export interface CrPaymentRequirement {
  scheme: "exact";
  network: string;
  /** Atomic USDC (6 decimals). */
  maxAmountRequired: string;
  asset: string;
  /** Base: recipient address. Solana: recipient OWNER pubkey (derive the ATA from it). */
  payTo: string;
  description?: string;
  maxTimeoutSeconds?: number;
  /** Base: EIP-712 domain bits. Solana: feePayer (CDP) — the transaction's payerKey. */
  extra?: { name?: string; version?: string; decimals?: number; feePayer?: string };
}

export interface CrPhase1 {
  rail: CrRail;
  sessionId: string;
  requirement: CrPaymentRequirement;
  /** Unix seconds — use as validBefore on the EIP-3009 authorization. */
  expiresAt: number;
}

export interface CrDelivery {
  delivery_state?: "pending" | "completed" | "failed";
  brand_name?: string;
  product_name?: string;
  denomination?: string;
  voucher_code?: string;
  pin_serial?: string;
  security_code?: string;
  redeem_instructions?: string;
  url?: string;
  qr_image_url?: string;
  barcode_image_url?: string;
  delivery_type?: string;
  failure_reason?: string;
}

export interface CrOrderStatus {
  order_id: string;
  status: "processing" | "completed" | "failed" | "expired";
  estimated_delivery_seconds?: number;
  poll_url?: string;
  deliveries?: CrDelivery[];
}

/** Upstream answered with an error. `code` is Cryptorefills' own reason (e.g. OUT_OF_STOCK) when present. */
export class CryptorefillsError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly code: string | null) {
    super(message);
    this.name = "CryptorefillsError";
  }
}

/** Largest single order we will let a user sign for. Override with CRYPTOREFILLS_MAX_ORDER_USD. */
export function maxOrderUsd(): number {
  const v = Number(getServerEnv("CRYPTOREFILLS_MAX_ORDER_USD"));
  return Number.isFinite(v) && v > 0 ? v : 500;
}

async function crFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, CR_HOST), {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

async function crError(res: Response): Promise<CryptorefillsError> {
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string; code?: string } | null;
  return new CryptorefillsError(
    body?.message ?? body?.error ?? `Cryptorefills ${res.status}`,
    res.status,
    body?.code ?? body?.error ?? null,
  );
}

async function crGetJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const res = await crFetch(`${path}?${qs}`);
  if (!res.ok) throw await crError(res);
  return (await res.json()) as T;
}

// ── Discovery (cached — the catalogue changes slowly) ─────────────────────────

const CATALOG_TTL_MS = 10 * 60_000;
const discoveryCache = new Map<string, { at: number; data: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data as T;
  const data = await load();
  discoveryCache.set(key, { at: Date.now(), data });
  if (discoveryCache.size > 300) discoveryCache.delete(discoveryCache.keys().next().value as string);
  return data;
}

/**
 * Brand logos. The x402 catalogue has none, but Cryptorefills' public
 * catalogue API (same brands, no key needed) returns logo_base_url + bg_color.
 * Best-effort: any failure just means no logos.
 */
async function brandLogos(countryCode: string): Promise<Map<string, { logo: string; bg?: string }>> {
  const map = new Map<string, { logo: string; bg?: string }>();
  try {
    const res = await fetch(`https://api.cryptorefills.com/v2/brands?country_code=${countryCode.toUpperCase()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return map;
    const body = (await res.json()) as {
      categories?: { brands?: { brand?: string; family?: string; logo_base_url?: string; logo_url?: string; bg_color?: string }[] }[];
    };
    for (const b of body.categories?.flatMap((c) => c.brands ?? []) ?? []) {
      const logo = b.logo_base_url ? `${b.logo_base_url}_300x190.webp` : b.logo_url;
      if (!logo || !logo.startsWith("https://cdn.cryptorefills.com/")) continue;
      for (const key of [b.brand, b.family]) if (key && !map.has(key.toLowerCase())) map.set(key.toLowerCase(), { logo, bg: b.bg_color });
    }
  } catch { /* logos are optional */ }
  return map;
}

export function listBrands(countryCode: string): Promise<CrBrand[]> {
  const cc = countryCode.toLowerCase();
  return cached(`brands:${cc}`, async () => {
    const [brands, logos] = await Promise.all([
      crGetJson<CrBrand[]>("/v1/brands", { country_code: cc }),
      brandLogos(cc),
    ]);
    return brands.map((b) => {
      const hit = logos.get(b.brand_name.toLowerCase()) ?? logos.get(b.family.toLowerCase());
      return hit ? { ...b, logo_url: hit.logo, bg_color: hit.bg } : b;
    });
  });
}

export function listCatalog(countryCode: string, brandName: string): Promise<CrCatalogItem[]> {
  const cc = countryCode.toLowerCase();
  return cached(`catalog:${cc}:${brandName}`, () =>
    crGetJson<CrCatalogItem[]>("/v1/catalog", { country_code: cc, brand_name: brandName }),
  );
}

/** Not cached — quotes expire after ~60s. */
export function quotePrice(q: { productId: string; countryCode: string; brandName: string; productValue?: number }): Promise<CrPriceQuote> {
  return crGetJson<CrPriceQuote>("/v1/price", {
    product_id: q.productId,
    country_code: q.countryCode.toLowerCase(),
    brand_name: q.brandName,
    product_value: q.productValue,
  });
}

// ── Checkout ─────────────────────────────────────────────────────────────────

function decodeB64urlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

type Jwk = webcrypto.JsonWebKey & { kid?: string };
let jwksCache: { at: number; keys: Jwk[] } | null = null;

async function getJwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.at < 60 * 60_000) return jwksCache.keys;
  const res = await crFetch("/.well-known/x402-jwks.json");
  if (!res.ok) throw new CryptorefillsError("Couldn't load Cryptorefills signing keys", res.status, null);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), keys };
  return keys;
}

/**
 * Verifies the gateway's X-Payment-Required-Signature (ES256 JWS) so a
 * tampered or spoofed 402 can't redirect the user's payment. Checks the
 * claims listed in /.well-known/x402.json → attestation.verify.
 */
async function verifyPaymentAttestation(
  jws: string | null,
  paymentRequiredHeader: string,
  sessionId: string,
  requirement: CrPaymentRequirement,
): Promise<void> {
  if (!jws) throw new CryptorefillsError("Payment request wasn't signed by Cryptorefills", 502, "UNSIGNED_402");
  const [h, p, s] = jws.split(".");
  if (!h || !p || !s) throw new CryptorefillsError("Malformed payment attestation", 502, "BAD_ATTESTATION");

  const header = decodeB64urlJson<{ alg?: string; kid?: string }>(h);
  if (header.alg !== "ES256") throw new CryptorefillsError("Unexpected attestation algorithm", 502, "BAD_ATTESTATION");

  const findKey = (keys: Jwk[]) => keys.find((k) => !header.kid || k.kid === header.kid);
  const jwk = findKey(await getJwks()) ?? findKey(await getJwks(true));
  if (!jwk) throw new CryptorefillsError("Unknown attestation key", 502, "BAD_ATTESTATION");

  const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(s, "base64url"),
    Buffer.from(`${h}.${p}`),
  );
  if (!ok) throw new CryptorefillsError("Payment attestation signature is invalid", 502, "BAD_ATTESTATION");

  const claims = decodeB64urlJson<{ iss?: string; exp?: number; sid?: string; pr_sha256?: string; pay_to?: string; network?: string }>(p);
  const prHash = createHash("sha256").update(paymentRequiredHeader).digest("base64url");
  const problems = [
    claims.iss !== CR_HOST && "iss",
    !(typeof claims.exp === "number" && claims.exp * 1000 > Date.now()) && "exp",
    claims.sid !== sessionId && "sid",
    claims.pr_sha256 !== prHash && "pr_sha256",
    // EVM addresses are case-insensitive; Solana base58 keys are not.
    (requirement.network === BASE_NETWORK
      ? claims.pay_to?.toLowerCase() !== requirement.payTo.toLowerCase()
      : claims.pay_to !== requirement.payTo) && "pay_to",
    claims.network !== requirement.network && "network",
  ].filter(Boolean);
  if (problems.length) {
    throw new CryptorefillsError(`Payment attestation mismatch (${problems.join(", ")})`, 502, "BAD_ATTESTATION");
  }
}

const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Phase 1. Returns the verified payment requirement for the chosen rail, for
 * the user to sign. Throws CryptorefillsError for upstream refusals
 * (OUT_OF_STOCK etc.) and for any 402 that fails verification or the order cap.
 */
export async function createOrderPhase1(order: CrOrderRequest, rail: CrRail = "base"): Promise<CrPhase1> {
  const res = await crFetch("/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Preferred-Network": rail },
    body: JSON.stringify(order),
  });
  if (res.status !== 402) {
    if (!res.ok) throw await crError(res);
    throw new CryptorefillsError(`Expected 402 from Cryptorefills, got ${res.status}`, 502, null);
  }

  const prHeader = res.headers.get("payment-required");
  const sessionId = res.headers.get("x-session-id");
  if (!prHeader || !sessionId) throw new CryptorefillsError("Incomplete payment request from Cryptorefills", 502, null);

  const envelope = decodeB64urlJson<{
    x402Version?: number;
    accepts?: (CrPaymentRequirement & { amount?: string })[];
    expiresAt?: number;
  }>(prHeader);
  const { network, asset } = RAILS[rail];
  const raw = envelope.accepts?.find((a) => a.network === network);
  if (!raw) throw new CryptorefillsError(`Cryptorefills didn't offer USDC on ${rail === "base" ? "Base" : "Solana"} for this order`, 502, null);
  // x402 v2 names it `amount`; Cryptorefills documents `maxAmountRequired`. Accept either.
  const requirement: CrPaymentRequirement = { ...raw, maxAmountRequired: raw.maxAmountRequired ?? raw.amount ?? "" };

  if (requirement.scheme !== "exact") throw new CryptorefillsError("Unsupported payment scheme", 502, null);
  const assetOk = rail === "base" ? requirement.asset.toLowerCase() === asset.toLowerCase() : requirement.asset === asset;
  if (!assetOk) throw new CryptorefillsError("Unexpected payment token", 502, null);
  const addrOk = rail === "base"
    ? /^0x[0-9a-fA-F]{40}$/.test(requirement.payTo)
    : BASE58_PUBKEY.test(requirement.payTo) && BASE58_PUBKEY.test(requirement.extra?.feePayer ?? "");
  if (!addrOk) throw new CryptorefillsError("Invalid payment address", 502, null);
  if (!/^\d+$/.test(requirement.maxAmountRequired)) throw new CryptorefillsError("Invalid payment amount", 502, null);

  await verifyPaymentAttestation(res.headers.get("x-payment-required-signature"), prHeader, sessionId, requirement);

  const usd = Number(requirement.maxAmountRequired) / 1e6;
  if (usd > maxOrderUsd()) {
    throw new CryptorefillsError(`Order total $${usd.toFixed(2)} is above the $${maxOrderUsd()} limit`, 400, "ORDER_LIMIT");
  }

  // Solana's window is ~60s (blockhash lifetime); Base's is ~15 min.
  const expiresAt = envelope.expiresAt
    ?? Math.floor(Date.now() / 1000) + Math.min(requirement.maxTimeoutSeconds ?? 900, 900);
  return { rail, sessionId, requirement, expiresAt };
}

/** Phase 2. `paymentSignature` is the base64url PAYMENT-SIGNATURE header built by the client. */
export async function createOrderPhase2(order: CrOrderRequest, paymentSignature: string, sessionId: string, rail: CrRail = "base"): Promise<CrOrderStatus> {
  const res = await crFetch("/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Preferred-Network": rail,
      "PAYMENT-SIGNATURE": paymentSignature,
      "X-Session-Id": sessionId,
    },
    body: JSON.stringify(order),
  });
  if (!res.ok) throw await crError(res);
  return (await res.json()) as CrOrderStatus;
}

export async function getOrder(orderId: string): Promise<CrOrderStatus> {
  const res = await crFetch(`/v1/orders/${encodeURIComponent(orderId)}`);
  if (!res.ok) throw await crError(res);
  return (await res.json()) as CrOrderStatus;
}

/** A message safe to show the user. */
export function describeCryptorefillsError(err: unknown): string {
  if (!(err instanceof CryptorefillsError)) return "Cryptorefills is unavailable right now. Please try again.";
  switch (err.code) {
    case "OUT_OF_STOCK": return "This product is out of stock right now. Try another amount or brand.";
    case "NOT_AVAILABLE_PRODUCT":
    case "NOT_ACTIVE": return "This product isn't available anymore. Pick another one.";
    case "INVALID_BENEFICIARY_ACCOUNT": return "That recipient doesn't look right. Check the email or phone number.";
    case "INVALID_EMAIL_DOMAIN": return "That email address can't receive mail. Use a real inbox.";
    case "ORDER_LIMIT": return err.message;
    case "AMOUNT_LESS_THEN_MINIMUM_ALLOWED": return "This amount is below the minimum for that coin. Pick a bigger amount or another coin.";
    case "MAXIMUM_AMOUNT_PER_ORDER_EXCEEDED": return "This order is above the maximum for one order.";
    case "DAILY_SPENDING_LIMIT_EXCEEDED": return "You've reached today's Cryptorefills spending limit. Try again tomorrow.";
    case "MONTHLY_SPENDING_LIMIT_EXCEEDED": return "You've reached this month's Cryptorefills spending limit.";
    case "KYC_MISSING":
    case "KYC_PENDING":
    case "VERIFICATION_REQUIRED": return "Cryptorefills needs to verify your identity for this purchase. Try gasless USDC instead, or verify at cryptorefills.com.";
    case "NOT_ALLOWED_PAYMENT_VIA":
    case "UNSUPPORTED_PROTOCOL_COIN_COMBINATION":
    case "SUSPENDED_COIN":
    case "SUSPENDED_NETWORK": return "That coin or network isn't available for this order right now. Pick another.";
    case "FULLNAME_MISSING": return "Paying on Tron needs a full name on file. Pick another network.";
    case "LOGIN_REQUIRED": return "This product needs a Cryptorefills account. Try another product.";
  }
  if (err.httpStatus === 503) return "The payment network is busy. Your payment wasn't taken. Try again in a moment.";
  if (err.httpStatus === 402) return "Your payment was rejected. Check your USDC balance and try again.";
  if (err.httpStatus === 400 || err.httpStatus === 422) return err.message;
  return "Cryptorefills is unavailable right now. Please try again.";
}

// ── Partner API: pay with any supported coin via a deposit address ───────────

export interface CrPaymentMethod {
  coin: string;
  network: string;
  coinLogo?: string;
  networkLogo?: string;
}

export interface CrPartnerRequest {
  email: string;
  brand_name: string;
  country_code: string;
  /** Catalogue denomination (e.g. "500 NGN"), or "range" with product_value. */
  denomination: string;
  product_value?: number;
  beneficiary_account: string;
  coin: string;
  network: string;
}

export interface CrPartnerOrder {
  order_id: string;
  wallet_address?: string;
  coin_amount?: string;
  coin?: string;
  network?: string;
  /** Payment URI for wallets (e.g. "bitcoin:…?amount=…"). */
  qr_text?: string;
  memo?: string;
  order_state?: string;
  payment_state?: string;
  expires_at?: string;
}

/** Normalised, UI-facing view of a partner order's progress. */
export interface CrPartnerStatus {
  order_id: string;
  status: "awaiting_payment" | "paid" | "completed" | "failed" | "expired" | "review";
  order_state?: string;
  payment_state?: string;
  deliveries: CrDelivery[];
}

export function partnerConfigured(): boolean {
  return !!getServerEnv("CRYPTOREFILLS_PARTNER_ID");
}

/** End-user context Cryptorefills requires on every partner call (fraud checks + limits). */
export interface CrEndUser { ip: string; userAgent: string }

function partnerHeaders(user?: CrEndUser): Record<string, string> {
  const partnerId = getServerEnv("CRYPTOREFILLS_PARTNER_ID");
  if (!partnerId) throw new CryptorefillsError("Other coins aren't set up on this server", 501, "PARTNER_NOT_CONFIGURED");
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Cr-Application": partnerId,
    "X-Cr-Version": "bluvfi-1.0",
    ...(user ? { "X-Forwarded-For": user.ip, "User-Agent": user.userAgent } : {}),
  };
}

async function partnerFetch(path: string, init: RequestInit & { user?: CrEndUser } = {}): Promise<Response> {
  const { user, ...rest } = init;
  return fetch(new URL(path, CR_PARTNER_HOST), {
    ...rest,
    headers: { ...partnerHeaders(user), ...(rest.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

/** Partner errors come back as { status, detail, reason? } or with a problems[] array. */
async function partnerError(res: Response): Promise<CryptorefillsError> {
  const body = (await res.json().catch(() => null)) as { detail?: string; reason?: string; problems?: { problem?: string }[] } | null;
  const code = body?.problems?.[0]?.problem ?? body?.detail ?? null;
  return new CryptorefillsError(body?.reason ?? code ?? `Cryptorefills ${res.status}`, res.status, code);
}

/**
 * Coins/networks a user can pay from their own wallet (USER_WALLET), minus
 * suspended ones. Public data — cached like the catalogue.
 */
export function listPaymentMethods(): Promise<CrPaymentMethod[]> {
  return cached("payment_vias", async () => {
    const res = await fetch(`${CR_PARTNER_HOST}/v3/payment_vias`, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new CryptorefillsError("Couldn't load payment options", res.status, null);
    const vias = (await res.json()) as {
      name: string;
      available?: boolean;
      currencies?: { name: string; logo_url?: string; is_suspended?: boolean; networks?: { name: string; logo_url?: string; is_suspended?: boolean }[] }[];
    }[];
    const out: CrPaymentMethod[] = [];
    for (const via of vias) {
      if (via.name !== "USER_WALLET" || via.available === false) continue;
      for (const c of via.currencies ?? []) {
        if (c.is_suspended) continue;
        for (const n of c.networks ?? []) {
          if (!n.is_suspended) out.push({ coin: c.name, network: n.name, coinLogo: c.logo_url, networkLogo: n.logo_url });
        }
      }
    }
    return out;
  });
}

function partnerBody(r: CrPartnerRequest) {
  return {
    email: r.email,
    user: { email: r.email, has_accepted_newsletter: false },
    payment: { type: "via", payment_via: "USER_WALLET", coin: r.coin, network: r.network },
    deliveries: [{
      beneficiary_account: r.beneficiary_account,
      brand_name: r.brand_name,
      country_code: r.country_code.toUpperCase(),
      denomination: r.denomination,
      ...(r.product_value !== undefined ? { product_value: r.product_value } : {}),
    }],
    lang: "en",
    acquisition: { utm_source: "bluvfi" },
  };
}

/** Dry run: same product, limit and compliance checks as a real order, but creates nothing. */
export async function validatePartnerOrder(r: CrPartnerRequest, user: CrEndUser): Promise<{ coin_amount?: string; coin?: string }> {
  const res = await partnerFetch("/v5/orders/validations", { method: "POST", body: JSON.stringify(partnerBody(r)), user });
  if (!res.ok) throw await partnerError(res);
  const body = (await res.json()) as { coin?: string; coin_amount?: string | number; problems?: { problem?: string; moreDetails?: unknown }[] };
  const problem = body.problems?.[0]?.problem;
  if (problem) throw new CryptorefillsError(problem, 422, problem);
  return { coin: body.coin, coin_amount: body.coin_amount === undefined ? undefined : String(body.coin_amount) };
}

/** Creates the order and returns the deposit address + exact amount. Only call when the user intends to pay. */
export async function createPartnerOrder(r: CrPartnerRequest, user: CrEndUser): Promise<CrPartnerOrder> {
  const res = await partnerFetch("/v5/orders", { method: "POST", body: JSON.stringify(partnerBody(r)), user });
  if (!res.ok) throw await partnerError(res);
  const b = (await res.json()) as Record<string, unknown>;
  const str = (...keys: string[]) => {
    for (const k of keys) { const v = b[k]; if (typeof v === "string" || typeof v === "number") return String(v); }
    return undefined;
  };
  const order: CrPartnerOrder = {
    order_id: str("order_id", "id", "reference_order_id") ?? "",
    wallet_address: str("wallet_address", "address"),
    coin_amount: str("coin_amount", "amount"),
    coin: str("coin") ?? r.coin,
    network: str("network") ?? r.network,
    qr_text: str("qr_text", "payment_uri"),
    memo: str("memo", "tag", "destination_tag", "payment_id"),
    order_state: str("order_state"),
    payment_state: str("payment_state"),
    expires_at: str("expiration_date", "expires_at", "expiration_time", "expired_at"),
  };
  if (!order.order_id || !order.wallet_address || !order.coin_amount) {
    console.error("[cryptorefills/partner] unexpected create-order shape:", Object.keys(b).join(","));
    throw new CryptorefillsError("Cryptorefills didn't return a payment address. Try another coin.", 502, null);
  }
  return order;
}

export async function getPartnerOrder(orderId: string): Promise<CrPartnerStatus> {
  const res = await partnerFetch(`/v5/orders/${encodeURIComponent(orderId)}`);
  if (!res.ok) throw await partnerError(res);
  const b = (await res.json()) as {
    order_id?: string;
    order_state?: string;
    payment_state?: string;
    deliveries?: { deliverable?: { pin_code?: string; pin?: string; serial?: string; url?: string; redeem_instructions?: string }; product_name?: string; brand_name?: string; delivery_state?: string }[];
  };
  const s = b.order_state ?? "";
  const status: CrPartnerStatus["status"] =
    s === "Done" ? "completed"
    : s === "Expired" ? "expired"
    : ["PaymentFailed", "PaymentSetupFailed", "Refunded", "Canceled", "Cancelled"].includes(s) ? "failed"
    : s === "WaitingForManualAction" ? "review"
    : ["PaymentReceived", "WaitingForDelivery"].includes(s) || b.payment_state === "PaymentReceived" ? "paid"
    : "awaiting_payment";
  // Map deliverables onto the same shape the x402 flow uses so one UI renders both.
  const deliveries: CrDelivery[] = (b.deliveries ?? []).map((d) => {
    const pin = d.deliverable?.pin_code ?? d.deliverable?.pin;
    const isUrl = !!pin && /^https?:\/\//i.test(pin);
    return {
      product_name: d.product_name,
      brand_name: d.brand_name,
      voucher_code: isUrl ? undefined : pin,
      url: isUrl ? pin : d.deliverable?.url,
      pin_serial: d.deliverable?.serial,
      redeem_instructions: d.deliverable?.redeem_instructions,
      delivery_type: pin ? "inline" : "by_email",
    };
  });
  return { order_id: b.order_id ?? orderId, status, order_state: b.order_state, payment_state: b.payment_state, deliveries };
}
