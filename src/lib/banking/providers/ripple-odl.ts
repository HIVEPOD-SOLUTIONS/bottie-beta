import crypto, { randomUUID } from "crypto";
import type {
  BankingProvider,
  ProviderBalance,
  BankingTransaction,
  CollectionParams,
  CollectionResult,
  PayoutParams,
  PayoutResult,
} from "../types";

/**
 * Ripple Payments ODL (On-Demand Liquidity) — RippleNet Server API.
 *
 * ⚠ NOT YET LIVE-TESTED. Scaffolded from Ripple's published docs
 * (docs.ripple.com/products/payments-odl) — endpoint paths and the overall
 * flow are documented there, but exact request/response field names are
 * not fully published. Every TODO below marks a spot to verify against a
 * real sandbox account before this goes live. Follows the same shape as
 * credible.ts: implements the shared BankingProvider interface for the
 * operations that map cleanly, plus extra ODL-specific methods (Request for
 * Payment, Reports, Smart Liquidation Service) for the rest — same pattern
 * Credible uses for its IDR/PHP/VND payout methods.
 *
 * Auth: OAuth2 client_credentials grant → JWT bearer token (6 hr default,
 * refreshed 5 min early — same caching pattern as bitrefill-mcp.ts).
 *
 * Core flow:
 *   Send:    POST /v1/orchestration-payments            (quote fetched + accepted automatically)
 *   Receive: POST /v1/orchestration-payments/{id}/lock
 *   Status:  webhook callback — ACCEPTED → LOCKED → SETTLED (or REJECTED/FAILED)
 */

// ── Base URL / token endpoint ───────────────────────────────────────────────
// No default — Ripple's docs don't publish a fixed public hostname the way
// Bitrefill's MCP does, and sandbox vs production hosts differ. Must be set
// explicitly via env; isConfigured() reflects that.
const ODL_BASE_URL = (process.env.RIPPLE_ODL_BASE_URL ?? "").replace(/\/$/, "");
const ODL_TOKEN_URL = process.env.RIPPLE_ODL_TOKEN_URL || `${ODL_BASE_URL}/oauth/token`;

// ── OAuth token cache (in-process, mirrors bitrefill-mcp.ts's getBearerToken) ──

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresAt > now) return _cachedToken.token;

  const clientId = process.env.RIPPLE_ODL_CLIENT_ID ?? "";
  const clientSecret = process.env.RIPPLE_ODL_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("RIPPLE_ODL_CLIENT_ID / RIPPLE_ODL_CLIENT_SECRET not set");
  }

  // TODO: confirm grant shape — Ripple's Payments Direct API docs describe
  // "request the access token" via client credentials but don't specify
  // whether it wants form-encoded body (as below), Basic auth header, or a
  // JSON body. This mirrors the most common OAuth2 client_credentials shape.
  const res = await fetch(ODL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ripple ODL token error: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = now + (data.expires_in - 300) * 1000; // refresh 5 min early
  _cachedToken = { token: data.access_token, expiresAt };
  return _cachedToken.token;
}

async function odlRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${ODL_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ripple ODL ${method} ${path} → ${res.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Ripple ODL: non-JSON response: ${text.slice(0, 200)}`);
  }
}

// ── Raw shapes ─────────────────────────────────────────────────────────────
// TODO: field names below are inferred from Ripple's documented concepts
// (Payment Flow, Payment States, Standard RippleNet Payment Object) — verify
// exact JSON keys against a real API response before relying on them.

export type OdlPaymentStatus = "ACCEPTED" | "LOCKED" | "SETTLED" | "REJECTED" | "FAILED";

export interface OrchestrationPayment {
  id: string;
  status: OdlPaymentStatus;
  source_amount?: { value: string; currency: string };
  destination_amount?: { value: string; currency: string };
  beneficiary?: Record<string, unknown>;
  created_at?: string;
}

export interface PaymentRequest {
  id: string;
  status: string;
  amount?: { value: string; currency: string };
  requester?: Record<string, unknown>;
  created_at?: string;
}

export interface OdlReport {
  id: string;
  type: "PAYMENT_OPS" | "RECON" | "FAILURE_CONVERSION_SSA" | string;
  format: "json" | "csv";
  status: string;
  created_at?: string;
  download_url?: string;
}

export interface Liquidation {
  id: string;
  status: string;
  states?: Record<string, unknown>[];
  created_at?: string;
}

// ── Mapper ─────────────────────────────────────────────────────────────────

const ODL_STATUS_MAP: Record<OdlPaymentStatus, BankingTransaction["status"]> = {
  ACCEPTED: "processing",
  LOCKED: "processing",
  SETTLED: "completed",
  REJECTED: "failed",
  FAILED: "failed",
};

function mapPayment(p: OrchestrationPayment): BankingTransaction {
  const amt = p.destination_amount ?? p.source_amount;
  return {
    id: p.id,
    merchantReferenceId: p.id,
    type: "payout",
    amount: amt ? Number(amt.value) : 0,
    currency: amt?.currency ?? "USD",
    status: ODL_STATUS_MAP[p.status] ?? "pending",
    createdAt: p.created_at,
  };
}

// ── Provider class ─────────────────────────────────────────────────────────

class RippleOdlProvider implements BankingProvider {
  readonly id = "ripple-odl";
  readonly name = "Ripple Payments ODL";
  readonly description = "Cross-border payments via On-Demand Liquidity — XRP-bridged settlement";
  readonly currency = "USD";
  readonly currencySymbol = "$";
  readonly flag = "🌐";
  readonly minCollectionAmount = 1;

  isConfigured(): boolean {
    return !!(
      process.env.RIPPLE_ODL_CLIENT_ID &&
      process.env.RIPPLE_ODL_CLIENT_SECRET &&
      process.env.RIPPLE_ODL_BASE_URL
    );
  }

  // ── Core payment flow ──────────────────────────────────────────────────

  /**
   * Sender side — POST /v1/orchestration-payments. Ripple fetches and
   * accepts a quote automatically as part of this call.
   * TODO: confirm the exact beneficiary field names for the corridor you're
   * sending to — these vary by destination country/rail in RippleNet.
   */
  async initiatePayout(userId: string, params: PayoutParams): Promise<PayoutResult> {
    const body = {
      merchant_reference_id: `odl-${userId}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      amount: params.amount,
      description: params.description,
      beneficiary: {
        name: params.beneficiaryName,
        account_number: params.beneficiaryAccountNumber,
        routing_code: params.beneficiaryIfsc,
      },
    };
    const data = await odlRequest<OrchestrationPayment>("POST", "/v1/orchestration-payments", body);
    return mapPayment(data) as PayoutResult;
  }

  /** Receiver side — POST /v1/orchestration-payments/{id}/lock. Beyond the base interface. */
  async lockIncomingPayment(paymentId: string): Promise<OrchestrationPayment> {
    return odlRequest<OrchestrationPayment>("POST", `/v1/orchestration-payments/${paymentId}/lock`);
  }

  async getTransaction(id: string): Promise<BankingTransaction> {
    const data = await odlRequest<OrchestrationPayment>("GET", `/v1/orchestration-payments/${id}`);
    return mapPayment(data);
  }

  /**
   * TODO: Ripple's docs (per the plan this was scaffolded from) don't confirm
   * a dedicated "list all payments" endpoint separate from the Reports API.
   * Until confirmed, this pulls the PAYMENT_OPS report as the closest
   * equivalent — replace with a direct list endpoint if RippleNet exposes
   * one (check the OpenAPI reference at
   * docs.ripple.com/products/payments-odl/api-docs/ripplenet/reference/openapi).
   */
  async getTransactions(): Promise<BankingTransaction[]> {
    const reports = await this.listReports();
    const opsReport = reports.find((r) => r.type === "PAYMENT_OPS");
    if (!opsReport?.download_url) return [];
    const token = await getAccessToken();
    const res = await fetch(opsReport.download_url, { headers: { Authorization: `Bearer ${token}` } });
    const rows = (await res.json().catch(() => [])) as OrchestrationPayment[];
    return Array.isArray(rows) ? rows.map(mapPayment) : [];
  }

  /**
   * TODO: no balance/held-funds endpoint is documented in the provided plan.
   * ODL is a payment-orchestration rail (source funds move through Ripple's
   * liquidity pool per-transaction), not necessarily a persistent merchant
   * wallet the way Credible's collections balance is. Confirm with Ripple
   * whether an account/balance concept applies to your integration type
   * before wiring a UI balance widget to this.
   */
  async getBalance(): Promise<ProviderBalance> {
    throw new Error("Ripple ODL: no balance endpoint documented yet — see TODO in ripple-odl.ts");
  }

  /**
   * ODL doesn't have a consumer-facing "collection" (QR/checkout link) the
   * way Credible's collections product does — its two-way flow is send
   * (initiatePayout) / receive (lockIncomingPayment). Mapped here to
   * Request for Payment as the closest analog: asking a counterparty to
   * pay you, which they then accept or the sender fulfils via a payment.
   */
  async initiateCollection(userId: string, params: CollectionParams): Promise<CollectionResult> {
    const req = await this.createPaymentRequest(userId, params.amount, params.description);
    return {
      id: req.id,
      merchantReferenceId: req.id,
      type: "collection",
      amount: params.amount,
      currency: this.currency,
      status: "pending",
      description: params.description,
    };
  }

  // ── Request for Payment ────────────────────────────────────────────────

  async listPaymentRequests(): Promise<PaymentRequest[]> {
    const data = await odlRequest<{ data: PaymentRequest[] }>("GET", "/v1/requests-for-payment");
    return data.data ?? [];
  }

  async createPaymentRequest(userId: string, amount: number, description?: string): Promise<PaymentRequest> {
    return odlRequest<PaymentRequest>("POST", "/v1/requests-for-payment", {
      merchant_reference_id: `rfp-${userId}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      amount,
      description,
    });
  }

  async acceptPaymentRequest(id: string): Promise<PaymentRequest> {
    return odlRequest<PaymentRequest>("POST", `/v1/requests-for-payment/${id}/accept`);
  }

  async failPaymentRequest(id: string, reason?: string): Promise<PaymentRequest> {
    return odlRequest<PaymentRequest>(
      "POST",
      `/v1/requests-for-payment/${id}/fail`,
      reason ? { reason } : undefined,
    );
  }

  // ── Reporting & reconciliation ─────────────────────────────────────────

  async listReports(): Promise<OdlReport[]> {
    const data = await odlRequest<{ data: OdlReport[] }>("GET", "/v1/reports");
    return data.data ?? [];
  }

  /** type: "PAYMENT_OPS" (investigation) | "RECON" (trade/liquidation detail) | "FAILURE_CONVERSION_SSA" (failure analysis) */
  async downloadReport(type: string, format: "json" | "csv" = "json"): Promise<unknown> {
    const reports = await this.listReports();
    const report = reports.find((r) => r.type === type && r.format === format);
    if (!report?.download_url) throw new Error(`Ripple ODL: no ${type} (${format}) report available`);
    const token = await getAccessToken();
    const res = await fetch(report.download_url, { headers: { Authorization: `Bearer ${token}` } });
    return format === "json" ? res.json() : res.text();
  }

  // ── Smart Liquidation Service — optional, for large payments split into tranches ──

  async listLiquidations(opts: { from?: string; to?: string } = {}): Promise<Liquidation[]> {
    const query = new URLSearchParams();
    if (opts.from) query.set("from", opts.from);
    if (opts.to) query.set("to", opts.to);
    const qs = query.toString();
    const data = await odlRequest<{ data: Liquidation[] }>(
      "GET",
      `/v1/liquidations${qs ? `?${qs}` : ""}`,
    );
    return data.data ?? [];
  }

  async getLiquidation(id: string): Promise<Liquidation> {
    return odlRequest<Liquidation>("GET", `/v1/liquidations/${id}`);
  }

  // ── Webhook verification ────────────────────────────────────────────────
  // TODO: Ripple's exact webhook signing scheme (header name, algorithm,
  // canonicalization) isn't detailed in the provided plan. This mirrors
  // credible.ts's HMAC-over-sorted-JSON convention as a placeholder — MUST
  // be confirmed against RippleNet's actual webhook docs before trusting it
  // to gate real payment-status updates.
  verifyWebhook(body: Record<string, unknown>): boolean {
    const { signature, ...payload } = body as { signature?: string } & Record<string, unknown>;
    if (!signature) return false;
    const secret = process.env.RIPPLE_ODL_WEBHOOK_SECRET ?? "";
    const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
    } catch {
      return false;
    }
  }
}

export const rippleOdlProvider = new RippleOdlProvider();
