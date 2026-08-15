/**
 * SpherePay API client — server-only.
 * Base URL: https://api.spherepay.co
 * Auth:    Bearer SPHEREPAY_API_KEY
 */

const BASE = "https://api.spherepay.co";

function apiKey(): string {
  const key = process.env.SPHEREPAY_API_KEY;
  if (!key) throw new Error("SPHEREPAY_API_KEY is not configured");
  return key;
}

async function sphereReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.detail ?? `SpherePay ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null) p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── Customers ─────────────────────────────────────────────────────────────────

export const listCustomers = (params?: { limit?: number; page?: number }) =>
  sphereReq<any>("GET", `/v2/customer${qs(params ?? {})}`);

export const createCustomer = (body: unknown) =>
  sphereReq<any>("POST", "/v2/customer", body);

export const getCustomer = (id: string) =>
  sphereReq<any>("GET", `/v2/customer/${id}`);

export const updateCustomer = (id: string, body: unknown) =>
  sphereReq<any>("PATCH", `/v2/customer/${id}`, body);

export const createCustomerViaLink = (body: { type: string; email: string }) =>
  sphereReq<any>("POST", "/v2/customer/kyc-link", body);

export const regenerateKycLink = (customerId: string) =>
  sphereReq<any>("POST", `/v2/customer/${customerId}/kyc`);

// ── Transfers ─────────────────────────────────────────────────────────────────

export const listTransfers = (params?: { customerId?: string; limit?: number; page?: number }) =>
  sphereReq<any>("GET", `/v2/transfer${qs(params ?? {})}`);

export const createTransfer = (body: unknown) =>
  sphereReq<any>("POST", "/v2/transfer", body);

export const getTransfer = (id: string) =>
  sphereReq<any>("GET", `/v2/transfer/${id}`);

export const cancelTransfer = (id: string) =>
  sphereReq<any>("DELETE", `/v2/transfer/${id}`);

// ── Quotes ────────────────────────────────────────────────────────────────────

export const createQuote = (body: unknown) =>
  sphereReq<any>("POST", "/v2/quote", body);

export const listQuotes = (params?: { customerId?: string; status?: string }) =>
  sphereReq<any>("GET", `/v2/quote${qs(params ?? {})}`);

export const getQuote = (id: string) =>
  sphereReq<any>("GET", `/v2/quote/${id}`);

export const updateQuoteStatus = (id: string, status: "used" | "expired") =>
  sphereReq<any>("PUT", `/v2/quote/${id}`, { status });

// ── Bank Accounts ─────────────────────────────────────────────────────────────

export const listBankAccounts = (customerId?: string) =>
  sphereReq<any>("GET", `/v2/bank-account${qs({ customerId })}`);

export const registerBankAccount = (body: unknown) =>
  sphereReq<any>("POST", "/v2/bank-account", body);

export const getBankAccount = (id: string) =>
  sphereReq<any>("GET", `/v2/bank-account/${id}`);

export const updateBankAccount = (id: string, body: unknown) =>
  sphereReq<any>("PATCH", `/v2/bank-account/${id}`, body);

export const deleteBankAccount = (id: string) =>
  sphereReq<any>("DELETE", `/v2/bank-account/${id}`);

// ── Wallets ───────────────────────────────────────────────────────────────────

export const listWallets = (customerId?: string) =>
  sphereReq<any>("GET", `/v2/wallet${qs({ customerId })}`);

export const registerWallet = (body: unknown) =>
  sphereReq<any>("POST", "/v2/wallet", body);

export const getWallet = (id: string) =>
  sphereReq<any>("GET", `/v2/wallet/${id}`);

export const deleteWallet = (id: string) =>
  sphereReq<any>("DELETE", `/v2/wallet/${id}`);

// ── Onramper Virtual Accounts ─────────────────────────────────────────────────

export const listVirtualAccounts = () =>
  sphereReq<any>("GET", "/v2/virtual-account");

export const createVirtualAccount = (body: unknown) =>
  sphereReq<any>("POST", "/v2/virtual-account", body);

export const getVirtualAccount = (id: string) =>
  sphereReq<any>("GET", `/v2/virtual-account/${id}`);

export const deactivateVirtualAccount = (id: string) =>
  sphereReq<any>("POST", `/v2/virtual-account/${id}/deactivate`);

export const reactivateVirtualAccount = (id: string) =>
  sphereReq<any>("POST", `/v2/virtual-account/${id}/reactivate`);

export const updateVirtualAccount = (id: string, body: unknown) =>
  sphereReq<any>("PATCH", `/v2/virtual-account/${id}`, body);

// ── Business Representatives (UBOs) ──────────────────────────────────────────

export const listBusinessReps = (customerId: string) =>
  sphereReq<any>("GET", `/v2/business-representative?customerId=${customerId}`);

export const createBusinessRep = (body: unknown) =>
  sphereReq<any>("POST", "/v2/business-representative", body);

export const getBusinessRep = (id: string) =>
  sphereReq<any>("GET", `/v2/business-representative/${id}`);

export const updateBusinessRep = (id: string, body: unknown) =>
  sphereReq<any>("PATCH", `/v2/business-representative/${id}`, body);

export const deleteBusinessRep = (id: string) =>
  sphereReq<any>("DELETE", `/v2/business-representative/${id}`);

// ── Documents ─────────────────────────────────────────────────────────────────

export const uploadDocument = (customerId: string, documentType: string, fileBase64: string, fileName: string, mimeType: string) =>
  sphereReq<any>("POST", "/v2/document", { customerId, documentType, file: fileBase64, fileName, mimeType });

// ── Offloader Wallets ─────────────────────────────────────────────────────────

export const listOffloaderWallets = () =>
  sphereReq<any>("GET", "/v2/offloader-wallet");

export const createOffloaderWallet = (body: unknown) =>
  sphereReq<any>("POST", "/v2/offloader-wallet", body);

export const getOffloaderWallet = (id: string) =>
  sphereReq<any>("GET", `/v2/offloader-wallet/${id}`);

export const updateOffloaderWallet = (id: string, body: unknown) =>
  sphereReq<any>("PATCH", `/v2/offloader-wallet/${id}`, body);
