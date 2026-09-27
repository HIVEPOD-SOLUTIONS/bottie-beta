/**
 * GetEquity Investments API — Managed model.
 * https://getequity.io/docs/api-reference/investments/managed
 *
 * Bluvfi is not a regulated entity, so it integrates as an intermediary: each Bluvfi user who
 * opts in gets a real GetEquity account (a "member") that Bluvfi's organisation acts on behalf
 * of via `api/members/{id}/*`, using the organisation's own secret key. GetEquity holds the
 * member's assets and cash — Bluvfi never custodies them.
 *
 * Money moves for real once GETEQUITY_SECRET_KEY is configured and GETEQUITY_ENV=live:
 * creating a member opens a real brokerage-style account in that person's name, and
 * buy/sell/fund/withdraw/commit move real cash and real securities. Every write here should be
 * called only after the calling code (AI tool or UI) has the end user's explicit, informed
 * confirmation of the exact numbers.
 *
 * Required env vars:
 *   GETEQUITY_SECRET_KEY — organisation secret key, sent as `Authorization: Bearer <key>`
 *   GETEQUITY_ENV        — "live" or "sandbox" (default: sandbox — the safer default for an
 *                          unconfigured integration that moves real money)
 */

const GETEQUITY_ENV = process.env.GETEQUITY_ENV === "live" ? "live" : "sandbox";

export const GETEQUITY_BASE = (
  process.env.GETEQUITY_API_BASE ??
  (GETEQUITY_ENV === "live"
    ? "https://ge-exchange.herokuapp.com/v1"
    : "https://ge-exchange-staging-1.herokuapp.com/v1")
).replace(/\/$/, "");

function getSecretKey() {
  const k = process.env.GETEQUITY_SECRET_KEY;
  if (!k) throw new Error("GETEQUITY_SECRET_KEY not configured");
  return k;
}

export function getGetEquityConfig() {
  return {
    env: GETEQUITY_ENV,
    baseUrl: GETEQUITY_BASE,
    hasApiKey: Boolean(process.env.GETEQUITY_SECRET_KEY),
  };
}

function qs(params?: Record<string, unknown>) {
  if (!params) return "";
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

async function geFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GETEQUITY_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getSecretKey()}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  if (!res.ok || parsed?.status === "failed" || parsed?.status === "error") {
    throw new Error(parsed?.message ?? `GetEquity ${init.method ?? "GET"} ${path} → ${res.status}`);
  }
  return (parsed?.data !== undefined ? parsed : parsed) as T;
}

// ── Market data (shared, read-only, no member scoping) ─────────────────────────────────────

/**
 * Verified live against the sandbox: only `page`/`limit` are actually accepted here — `closed`,
 * `exited`, `private`, `investment_type` and `raising` all come back `"X" is not allowed in
 * query` (412), despite being in GetEquity's own docs/example URL for this endpoint. Filter by
 * investment type client-side, or use listRaisingTokens / searchTokens instead.
 */
export function listTokens(params?: { page?: number; limit?: number }) {
  return geFetch<unknown>(`/api/tokens${qs({ page: params?.page, limit: params?.limit })}`);
}

export function listRaisingTokens(params?: { page?: number; limit?: number }) {
  return geFetch<unknown>(`/api/tokens/raising${qs(params)}`);
}

/**
 * Verified live: `name`, `symbol`, `page`, `limit`, `exited` and `completed_raise` are accepted.
 * `investment_type` and `private` are documented as ParamFields here too, but the sandbox
 * rejects both the same way as listTokens — omitted here for the same reason.
 */
export function searchTokens(params: {
  name?: string;
  symbol?: string;
  page?: number;
  limit?: number;
  exited?: boolean;
  completed_raise?: boolean;
}) {
  return geFetch<unknown>(
    `/api/token/search${qs({
      name: params.name,
      symbol: params.symbol,
      page: params.page,
      limit: params.limit,
      exited: params.exited,
      completed_raise: params.completed_raise,
    })}`,
  );
}

export function getToken(tokenId: string) {
  return geFetch<unknown>(`/api/token/${tokenId}`);
}

export function getAsset(assetId: string) {
  return geFetch<unknown>(`/api/asset/${assetId}`);
}

/**
 * Verified live: this route 404s ("Page not found") for every token tried, including a garbage
 * id — a routing-level 404, not a per-token "no history" response. Either historicals aren't
 * enabled on the sandbox, or the real path differs from GetEquity's own docs. Treat a failure
 * here as "not available in this environment" rather than "no price history for this token."
 */
export function getTokenHistoricals(tokenId: string, params?: { from?: string; to?: string; interval?: string }) {
  return geFetch<unknown>(`/api/token/${tokenId}/ohlvc${qs(params)}`);
}

/** Aggregate demand, cover and the demand ladder for a live offering — read before bidding. */
export function getOfferingBook(tokenId: string, params?: { tranche?: string }) {
  return geFetch<unknown>(`/api/token/${tokenId}/book${qs(params)}`);
}

// ── Transactions (shared) ───────────────────────────────────────────────────────────────────

/**
 * Look up a transaction by the `tx_ref` GetEquity issued (or its own id) to find out whether a
 * payment actually went through. `status`/`paid` is the provider's account; `settled` is
 * whether GetEquity has actually credited the wallet — treat only `settled: true` as final.
 */
export function getTransaction(reference: string, transactionId?: string) {
  return geFetch<unknown>(`/api/transactions/${reference}${qs({ transaction_id: transactionId })}`);
}

// ── Members: provisioning ───────────────────────────────────────────────────────────────────

export interface CreateMemberInput {
  fname: string;
  lname: string;
  email: string;
  phone: string;
  password: string;
  dob: string; // YYYY-MM-DD
  sex: string;
  homeAddress: string;
  city: string;
  state: string;
  country: string;
}

/**
 * Provisions a real GetEquity account for this person and enrols it in Bluvfi's syndicate.
 * Created already KYC-approved ("Sophisticated Investor") — it can transact immediately. If the
 * email already has a GetEquity account, that account is linked rather than duplicated.
 *
 * Every one of the eleven fields is required by GetEquity and an unknown field is a 400 — do
 * not add fields (e.g. no `username`). Call this only with the end user's explicit consent to
 * open a GetEquity account, since it is a real, KYC-approved brokerage-style account in their
 * name — never fabricate personal details to satisfy the required fields.
 */
export function createMember(input: CreateMemberInput) {
  return geFetch<unknown>("/api/member", { method: "POST", body: JSON.stringify(input) });
}

/**
 * Verified live: `page`/`limit` are rejected here (412, "not allowed in query"), so this takes
 * no params — despite GetEquity's own docs pairing this exact GET with the paginated
 * "Get Members" response shape. In the sandbox it currently answers with the single-member
 * shape (`data: null` when nothing matches), the same as getMemberByEmail with no email — so
 * treat a bare list-all as unverified until GetEquity's side is confirmed to return the
 * documented `{ members: [...] }` page.
 */
export function getMembers() {
  return geFetch<unknown>("/api/member");
}

export function getMemberByEmail(email: string) {
  return geFetch<unknown>(`/api/member${qs({ email })}`);
}

// ── Members: reporting ──────────────────────────────────────────────────────────────────────

export function getMemberBalance(memberId: string) {
  return geFetch<unknown>(`/api/members/${memberId}/balance`);
}

export function getMemberTokenBalance(memberId: string) {
  return geFetch<unknown>(`/api/members/${memberId}/tokens`);
}

export function getMemberOrders(memberId: string, params?: { page?: number; limit?: number }) {
  return geFetch<unknown>(`/api/members/${memberId}/orders${qs(params)}`);
}

export function getMemberTransactions(memberId: string, params?: { page?: number; limit?: number }) {
  return geFetch<unknown>(`/api/members/${memberId}/transactions${qs(params)}`);
}

// ── Members: investing on their behalf (moves real money) ──────────────────────────────────

/** Places a secondary-market buy order for the member. Escrows the member's own wallet balance. */
export function buyTokenAsMember(memberId: string, tokenId: string, body: { amount: number; currency: string }) {
  return geFetch<unknown>(`/api/members/${memberId}/token/${tokenId}/buy`, { method: "POST", body: JSON.stringify(body) });
}

/** Places a secondary-market sell order for tokens the member already holds. */
export function sellTokenAsMember(memberId: string, tokenId: string, body: { amount: number; currency: string }) {
  return geFetch<unknown>(`/api/members/${memberId}/token/${tokenId}/sell`, { method: "POST", body: JSON.stringify(body) });
}

/** Fee preview for a fund-and-invest — call this before fundInvest so the user sees the total charge first. */
export function getFundInvestQuote(memberId: string, tokenId: string, body: { investmentAmount: number; currency: string }) {
  return geFetch<unknown>(`/api/members/${memberId}/token/${tokenId}/fund-invest/quote`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Initiates a fund-and-invest: a payment (card or bank transfer) that funds the member's wallet
 * and invests in one flow. Returns a payment link (card) or a virtual account (bank transfer) —
 * the member/user completes payment themselves; nothing is charged by this call.
 */
export function fundInvest(memberId: string, tokenId: string, body: {
  investmentAmount: number;
  currency: string;
  redirectUrl?: string;
  paymentMethod: "card" | "bank_transfer";
}) {
  return geFetch<unknown>(`/api/members/${memberId}/token/${tokenId}/fund-invest`, { method: "POST", body: JSON.stringify(body) });
}

/** Bid into a live offering on the member's behalf. Funds are held on the member's own wallet. */
export function commitToOfferingAsMember(memberId: string, tokenId: string, body: {
  amount: number;
  bid_price?: number;
  bid_rate?: number;
  strike?: boolean;
  tranche?: string;
  meta?: Record<string, unknown>;
}) {
  return geFetch<unknown>(`/api/members/${memberId}/token/${tokenId}/commit`, { method: "POST", body: JSON.stringify(body) });
}

export function cancelMemberOrder(memberId: string, orderId: string) {
  return geFetch<unknown>(`/api/members/${memberId}/orders/${orderId}/cancel`, { method: "POST" });
}

// ── Members: funding & withdrawals (moves real money) ───────────────────────────────────────

/** Funds the member's wallet only — no token purchase. Use fundInvest to fund-and-buy in one step. */
export function fundMemberWallet(memberId: string, body: {
  amount: number;
  currency: "NGN" | "USD" | "KES" | "GHS" | "ZAR" | "GBP" | "EUR";
  redirectUrl?: string;
  paymentMethod?: "card" | "bank_transfer" | "ussd" | "mobilemoney";
}) {
  return geFetch<unknown>(`/api/members/${memberId}/wallet/fund`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Creates a withdrawal request (status Pending) debiting the member's own wallet to a bank
 * account. Needs approval on GetEquity's side before funds are disbursed.
 */
export function withdrawMemberWallet(memberId: string, body: {
  amount: number;
  bank_name: string;
  account_name: string;
  account_number: string;
  currency: "NGN" | "KES" | "GHS" | "ZAR" | "UGX" | "TZS";
}) {
  return geFetch<unknown>(`/api/members/${memberId}/wallet/withdraw`, { method: "POST", body: JSON.stringify(body) });
}
