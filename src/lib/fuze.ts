/**
 * Fuze Finance API client — global crypto + fiat infrastructure.
 *
 * Auth: HMAC SHA256 signature over JSON payload.
 *   Headers: X-API-KEY, X-TIMESTAMP (epoch seconds), X-SIGNATURE
 *   Signature = HMAC_SHA256(secret, JSON.stringify({ body, query, url, ts }))
 *
 * OAuth 2.0 is also supported (client_credentials) but signature method is used here.
 *
 * Base URLs:
 *   Preprod:    https://preprod.api.fuze.finance
 *   Production: https://api.fuze.finance  (set FUZE_API_BASE)
 *
 * Required env vars (server-only — NEVER prefix with NEXT_PUBLIC_):
 *   FUZE_API_KEY     — API key from Fuze dashboard
 *   FUZE_API_SECRET  — API secret for HMAC signing
 *   FUZE_API_BASE    — optional override (default: https://staging.api.fuze.finance)
 */

import crypto from "crypto";

export const FUZE_BASE = (
  process.env.FUZE_API_BASE ?? "https://preprod.api.fuze.finance"
).replace(/\/$/, "");

function sign(path: string, query: Record<string, string>, body: unknown, ts: number): string {
  const secret = process.env.FUZE_API_SECRET ?? "";
  const payload = JSON.stringify({ body: body ?? {}, query, url: path, ts });
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function fuzeReq<T>(
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
  query: Record<string, string> = {},
): Promise<T> {
  const apiKey = process.env.FUZE_API_KEY;
  if (!apiKey) throw new Error("FUZE_API_KEY not configured");

  const ts = Math.floor(Date.now() / 1000);
  const sig = sign(path, query, body, ts);

  const qs = Object.keys(query).length ? "?" + new URLSearchParams(query).toString() : "";
  const res = await fetch(`${FUZE_BASE}${path}${qs}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
      "X-TIMESTAMP": String(ts),
      "X-SIGNATURE": sig,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json?.message ?? json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type UserType = "USER" | "ORG_USER";
export type KycStatus = "PENDING" | "ACTION_REQUIRED" | "APPROVED" | "REJECTED";
export type TransferStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "ACTION_REQUIRED";
export type OrderStatus = "COMPLETED" | "PENDING" | "FAILED";
export type PayoutStatus = "COMPLETED" | "PENDING" | "FAILED" | "CANCELED" | "REVERSED" | "EXPIRED";

export interface FuzeUser {
  id: string;
  orgUserId: string;
  userType: UserType;
  kycStatus?: KycStatus;
  email?: string;
  createdAt?: string;
}

export interface FuzeWallet {
  id: string;
  userId: string;
  currency: string;
  network: string;
  address?: string;
  balance?: number;
}

export interface FuzeAccount {
  id: string;
  userId: string;
  currency: string;
  balance?: number;
  depositInstructions?: Record<string, string>;
}

export interface FuzeCounterparty {
  id: string;
  type: "SELF" | "THIRD_PARTY";
  name?: string;
  legalName?: string;
}

export interface FuzeTransfer {
  id: string;
  status: TransferStatus;
  amount: number;
  currency: string;
  createdAt?: string;
}

export interface FuzeQuote {
  quoteId: number;
  from: { currency: string; amount: number };
  to: { currency: string; amount: number };
  conversionRate: number;
  expiryTime: number;
  createdAt?: string;
}

export interface FuzeOrder {
  orderId: number;
  from: { currency: string; amount: number };
  to: { currency: string; amount: number };
  conversionRate: number;
  status: OrderStatus;
  filled?: number;
  createdAt?: string;
}

export interface RemittanceQuote {
  quoteId: number;
  fromCurrency: string;
  toCurrency: string;
  quantity: number;
  price: number;
  expiryTime: number;
}

export interface RemittancePayment {
  uuid: string;
  fromCurrency: string;
  toCurrency: string;
  quantity: number;
  status: string;
}

export interface RemittancePayout {
  payoutId: number;
  amount: number;
  currency: string;
  payoutStatus: string;
  createdAt: string;
  paymentReferenceNumber?: string;
  paymentDate?: string;
  clientOrderId: string;
  name?: string;
  email?: string;
  senderStatus?: string;
  senderClientIdentifier?: string;
  receiverClientIdentifier?: string;
}

export interface RemittanceBalance {
  balance: Array<{ currency: string; value: number; creditLimit: number }>;
}

export interface BeneficiaryVerification {
  status: "ACTIVE" | "INACTIVE" | "PENDING";
  clientIdentifier: string;
}

export interface RemittanceThirdParty {
  uuid?: string;
  type: "ORIGINATOR" | string;
  status?: string;
  clientIdentifier: string;
  name?: string;
  email?: string;
  phoneNumber?: string;
  address?: string;
  nationality?: string;
  country?: string;
  dob?: string;
  account?: {
    uuid?: string;
    status?: string;
    clientIdentifier?: string;
    receiverStatus?: string;
    receiverClientIdentifier?: string;
  };
}

export interface RemittanceBeneficiary {
  uuid?: string;
  status?: string;
  clientIdentifier: string;
  thirdPartyClientIdentifier?: string;
  currency: string;
  accountType: string;
  country: string;
  accountData?: Record<string, unknown>;
}

export interface FuzeGatewayCustomer {
  clientIdentifier: string;
  name?: string;
  email?: string;
  status?: string;
  createdAt?: string;
}

export interface FuzeGatewayDepositWallet {
  clientIdentifier: string;
  address: string;
  chain: string;
  network?: string;
  asset?: string;
  symbol: string;
  status?: string;
  createdAt?: string;
}

export interface FuzeGatewayPayment {
  id?: number;
  clientIdentifier: string;
  clientOrderId: string;
  address?: string;
  chain?: string;
  network?: string;
  status: string;
  symbol: string;
  amount?: number;
  receivedAmount?: number;
  fee?: number;
  vat?: number;
  quantity?: number;
  quoteQuantity?: number;
  quoteId?: number;
  parentClientOrderId?: string;
  txHash?: string;
  sourceAddress?: string;
  expiryTime?: string | number;
  createdAt?: string;
}

export interface FuzeGatewayQuote {
  quoteId: number;
  symbol: string;
  operation?: "BUY" | "SELL";
  chain?: string;
  quantity?: number;
  quoteQuantity?: number;
  price?: number;
  fee?: number;
  vat?: number;
  expiryTime?: string | number;
}

// ── Users ──────────────────────────────────────────────────────────────────────

export function createUser(params: {
  orgUserId: string;
  userType: UserType;
  email?: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  country?: string;
}) {
  return fuzeReq<{ data: FuzeUser }>("POST", "/api/v1/customers", params);
}

export function getUser(orgUserId: string) {
  return fuzeReq<{ data: FuzeUser }>("GET", `/api/v1/customers/${orgUserId}`);
}

export function listUsers(params?: { page?: number; limit?: number }) {
  return fuzeReq<{ data: FuzeUser[]; total: number }>("GET", "/api/v1/customers", undefined, {
    ...(params?.page != null && { page: String(params.page) }),
    ...(params?.limit != null && { limit: String(params.limit) }),
  });
}

export function updateUser(orgUserId: string, params: Record<string, unknown>) {
  return fuzeReq<{ data: FuzeUser }>("PUT", `/api/v1/customers/${orgUserId}`, params);
}

export function getUserKycLink(orgUserId: string) {
  return fuzeReq<{ data: { kycLink: string } }>("POST", `/api/v1/customers/${orgUserId}/kyc/link`);
}

export function getUserBalance(orgUserId: string) {
  return fuzeReq<{ data: { balances: Array<{ currency: string; amount: number }> } }>(
    "GET", `/api/v1/customers/${orgUserId}/balance`
  );
}

export function deleteUser(orgUserId: string) {
  return fuzeReq<{ success: boolean }>("DELETE", `/api/v1/customers/${orgUserId}`);
}

export function acceptTermsAndConditions(orgUserId: string) {
  return fuzeReq<{ success: boolean }>("POST", "/api/v1/ol/user/tnc/update", { orgUserId, tnc: true });
}

// ── Counterparties ─────────────────────────────────────────────────────────────

export function createCounterparty(params: {
  orgUserId: string;
  type: "SELF" | "THIRD_PARTY";
  name?: string;
  legalName?: string;
  email?: string;
  country?: string;
}) {
  return fuzeReq<{ data: FuzeCounterparty }>("POST", "/api/v1/counterparties", params);
}

export function getCounterparty(counterpartyId: string) {
  return fuzeReq<{ data: FuzeCounterparty }>("GET", `/api/v1/counterparties/${counterpartyId}`);
}

export function listCounterparties(orgUserId: string) {
  return fuzeReq<{ data: FuzeCounterparty[] }>("GET", "/api/v1/counterparties", undefined, { orgUserId });
}

// ── Wallets (crypto) ───────────────────────────────────────────────────────────

export function createInternalWallet(params: { orgUserId: string; currency: string; network: string }) {
  return fuzeReq<{ data: FuzeWallet }>("POST", "/api/v1/wallets/internal", params);
}

export function getInternalWallet(walletId: string) {
  return fuzeReq<{ data: FuzeWallet }>("GET", `/api/v1/wallets/internal/${walletId}`);
}

export function listInternalWallets(orgUserId: string) {
  return fuzeReq<{ data: FuzeWallet[] }>("GET", "/api/v1/wallets/internal", undefined, { orgUserId });
}

export function registerExternalWallet(params: {
  counterpartyId: string;
  currency: string;
  network: string;
  address: string;
  type?: "SELF" | "THIRD_PARTY";
  memo?: string;
}) {
  return fuzeReq<{ data: FuzeWallet }>("POST", "/api/v1/wallets/external", params);
}

export function listExternalWallets(counterpartyId: string) {
  return fuzeReq<{ data: FuzeWallet[] }>("GET", "/api/v1/wallets/external", undefined, { counterpartyId });
}

export function deleteExternalWallet(walletId: string) {
  return fuzeReq<{ success: boolean }>("DELETE", `/api/v1/wallets/external/${walletId}`);
}

// ── Fiat Accounts ──────────────────────────────────────────────────────────────

export function createInternalAccount(params: { orgUserId: string; currency: string }) {
  return fuzeReq<{ data: FuzeAccount }>("POST", "/api/v1/accounts/internal", params);
}

export function getInternalAccount(accountId: string) {
  return fuzeReq<{ data: FuzeAccount }>("GET", `/api/v1/accounts/internal/${accountId}`);
}

export function listInternalAccounts(orgUserId: string) {
  return fuzeReq<{ data: FuzeAccount[] }>("GET", "/api/v1/accounts/internal", undefined, { orgUserId });
}

export function registerExternalAccount(params: {
  counterpartyId: string;
  currency: string;
  beneficiaryName: string;
  accountNumber: string;
  bankName: string;
  country: string;
  routingCode?: string;
  iban?: string;
  swiftBic?: string;
}) {
  return fuzeReq<{ data: FuzeAccount }>("POST", "/api/v1/accounts/external", params);
}

export function listExternalAccounts(counterpartyId: string) {
  return fuzeReq<{ data: FuzeAccount[] }>("GET", "/api/v1/accounts/external", undefined, { counterpartyId });
}

// ── Transfers ──────────────────────────────────────────────────────────────────

export function updateExternalTransfer(transferId: string, updates: Record<string, unknown>) {
  return fuzeReq<{ data: FuzeTransfer }>("PUT", `/api/v1/transfers/external/${transferId}`, updates);
}

export function confirmExternalTransfer(transferId: string) {
  return fuzeReq<{ data: FuzeTransfer }>("POST", `/api/v1/transfers/external/${transferId}/confirm`);
}

export function createReversalTransaction(transferId: string, reason?: string) {
  return fuzeReq<{ data: FuzeTransfer }>("POST", "/api/v1/transfers/reversal", { transferId, reason });
}

export function getTransferUploadLink(transferId: string, docType: string) {
  return fuzeReq<{ data: { uploadUrl: string; fileKey: string } }>(
    "POST", "/api/v1/ol/transfers/file-upload-link", { transferId, docType }
  );
}

export function listTransferCurrencies() {
  return fuzeReq<{ data: Array<{ currency: string; type: string; networks?: string[] }> }>(
    "GET", "/api/v1/ol/transfers/currencies"
  );
}

export function listRequiredTransferFiles(purpose: string, currency: string) {
  return fuzeReq<{ data: Array<{ docType: string; required: boolean; description?: string }> }>(
    "GET", "/api/v1/ol/transfers/required-files", undefined, { purpose, currency }
  );
}

export function createInternalTransfer(params: {
  fromOrgUserId: string;
  toOrgUserId: string;
  amount: number;
  currency: string;
  description?: string;
  clientOrderId?: string;
}) {
  return fuzeReq<{ data: FuzeTransfer }>("POST", "/api/v1/transfers/internal", params);
}

export function createExternalTransfer(params: {
  orgUserId: string;
  counterpartyId: string;
  externalAccountId?: string;
  externalWalletId?: string;
  amount: number;
  currency: string;
  description?: string;
  clientOrderId?: string;
}) {
  return fuzeReq<{ data: FuzeTransfer }>("POST", "/api/v1/transfers/external", params);
}

export function getTransfer(transferId: string) {
  return fuzeReq<{ data: FuzeTransfer }>("GET", `/api/v1/transfers/${transferId}`);
}

export function listTransfers(orgUserId: string, params?: { page?: number; limit?: number }) {
  return fuzeReq<{ data: FuzeTransfer[]; total: number }>("GET", "/api/v1/transfers", undefined, {
    orgUserId,
    ...(params?.page != null && { page: String(params.page) }),
    ...(params?.limit != null && { limit: String(params.limit) }),
  });
}

// ── Reference data ────────────────────────────────────────────────────────────

export function listCountries() {
  return fuzeReq<{ data: Array<{ code: string; name: string; supported: boolean }> }>("GET", "/api/v1/ol/countries");
}

export function listAccountCurrencies() {
  return fuzeReq<{ data: Array<{ currency: string; name: string; type: string }> }>("GET", "/api/v1/ol/accounts/currencies");
}

export function listWalletCurrencies() {
  return fuzeReq<{ data: Array<{ currency: string; name: string; networks: string[] }> }>("GET", "/api/v1/ol/wallets/currencies");
}

export function listVasps() {
  return fuzeReq<{ data: Array<{ id: string; name: string; did?: string }> }>("GET", "/api/v1/ol/vasps");
}

// ── Counter-party (delete) ─────────────────────────────────────────────────────

export function deleteCounterparty(counterpartyId: string) {
  return fuzeReq<{ success: boolean }>("DELETE", `/api/v1/counterparties/${counterpartyId}`);
}

// ── KYC document upload ────────────────────────────────────────────────────────

export function upsertUserKyc(orgUserId: string, kycData: Record<string, unknown>) {
  return fuzeReq<{ success: boolean }>("POST", "/api/v1/ol/user/kyc", { orgUserId, ...kycData });
}

export function getKycFileUploadLink(orgUserId: string, docCategory: string) {
  return fuzeReq<{ data: { uploadUrl: string; fileKey: string } }>(
    "POST", "/api/v1/ol/user/file-upload-link", { orgUserId, docCategory }
  );
}

export function updateEddTracker(orgUserId: string, eddCompleted: boolean) {
  return fuzeReq<{ success: boolean }>(
    "POST", "/api/v1/ol/user/edd", { orgUserId, eddCompleted }
  );
}

export function screenExternalWallet(address: string, currency: string, network: string) {
  return fuzeReq<{ data: { address: string; risk: string; sanctioned: boolean; details?: unknown } }>(
    "POST", "/api/v1/ol/wallets/external/screen", { address, currency, network }
  );
}

export function listWallets(orgUserId: string, walletType?: "INTERNAL" | "EXTERNAL") {
  return fuzeReq<{ data: FuzeWallet[] }>("GET", "/api/v1/ol/wallets", undefined, {
    orgUserId,
    ...(walletType && { walletType }),
  });
}

export function getWalletById(walletId: string) {
  return fuzeReq<{ data: FuzeWallet }>("GET", `/api/v1/ol/wallets/${walletId}`);
}

export function listAccountsUnified(orgUserId: string) {
  return fuzeReq<{ data: FuzeAccount[] }>("GET", "/api/v1/ol/accounts", undefined, { orgUserId });
}

export function getAccountById(accountId: string) {
  return fuzeReq<{ data: FuzeAccount }>("GET", `/api/v1/ol/accounts/${accountId}`);
}

// ── Asset catalog & pricing ────────────────────────────────────────────────────

export function listAssets() {
  return fuzeReq<{ data: Array<{ symbol: string; name: string; iconUrl?: string; marketCap?: number; priceChange24h?: number }> }>(
    "GET", "/api/v1/ol/assets"
  );
}

export function getCurrentPrice(symbol: string) {
  return fuzeReq<{ data: { symbol: string; price: number; timestamp: number } }>(
    "GET", "/api/v1/ol/price/current", undefined, { symbol }
  );
}

export function getCandlePrice(symbol: string, interval?: string) {
  return fuzeReq<{ data: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }> }>(
    "GET", "/api/v1/ol/price/candle", undefined, { symbol, ...(interval && { interval }) }
  );
}

export function getHistoricalPrices(symbol: string, from?: number, to?: number) {
  return fuzeReq<{ data: Array<{ time: number; price: number }> }>(
    "GET", "/api/v1/ol/price/historical", undefined, {
      symbol,
      ...(from && { from: String(from) }),
      ...(to && { to: String(to) }),
    }
  );
}

export function getNews(limit?: number) {
  return fuzeReq<{ data: Array<{ id: string; title: string; summary?: string; url?: string; publishedAt?: string }> }>(
    "GET", "/api/v1/ol/news", undefined, { ...(limit && { limit: String(limit) }) }
  );
}

// ── Trading ────────────────────────────────────────────────────────────────────

export function cancelOrder(orderId: number, orgUserId: string) {
  return fuzeReq<{ data: { orderId: number; status: string } }>("POST", "/api/v1/ol/order/cancel", { orderId, orgUserId });
}

export function getTradeOrder(orderId: number) {
  return fuzeReq<{ data: FuzeOrder }>("POST", "/api/v1/ol/order/get", { orderId });
}

export function listTradeOrders(orgUserId: string, params?: { page?: number; limit?: number }) {
  return fuzeReq<{ data: FuzeOrder[]; total: number }>("GET", "/api/v1/ol/order/list", undefined, {
    orgUserId,
    ...(params?.page != null && { page: String(params.page) }),
    ...(params?.limit != null && { limit: String(params.limit) }),
  });
}

export function getUserPnl(orgUserId: string) {
  return fuzeReq<{ data: { totalPnl: number; realizedPnl: number; unrealizedPnl?: number; currency: string } }>(
    "GET", "/api/v1/ol/user/pnl", undefined, { orgUserId }
  );
}

export function getWatchlist(orgUserId: string) {
  return fuzeReq<{ data: Array<{ symbol: string; price?: number; priceChange24h?: number }> }>(
    "GET", "/api/v1/ol/watchlist", undefined, { orgUserId }
  );
}

export function createTradeQuote(params: {
  customerId: string;
  from: { currency: string; amount: number };
  to: { currency: string };
}) {
  return fuzeReq<{ data: FuzeQuote }>("POST", "/api/v1/ol/quote/create", params);
}

export function createTradeOrder(params: { customerId: string; quoteId: number }) {
  return fuzeReq<{ data: FuzeOrder }>("POST", "/api/v1/ol/order/create", params);
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export function upsertWebhook(params: { url: string; secret: string; events?: string[] }) {
  return fuzeReq<{ data: { id: string; url: string; active: boolean } }>("POST", "/api/v1/ol/webhook", params);
}

export function getWebhook() {
  return fuzeReq<{ data: { id: string; url: string; active: boolean } }>("GET", "/api/v1/ol/webhook");
}

export function simulateWebhook(entity: string, eventType: string) {
  return fuzeReq<{ success: boolean }>("POST", "/api/v1/ol/webhook/simulate", { entity, eventType });
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export function createWatchlist(orgUserId: string, symbols: string[]) {
  return fuzeReq<{ data: { id: string; symbols: string[] } }>("POST", "/api/v1/ol/watchlist", { orgUserId, symbols });
}

export function updateWatchlist(orgUserId: string, watchlistId: string, symbols: string[]) {
  return fuzeReq<{ data: { id: string; symbols: string[] } }>("PUT", `/api/v1/ol/watchlist/${watchlistId}`, { orgUserId, symbols });
}

export function deleteWatchlist(orgUserId: string, watchlistId: string) {
  return fuzeReq<{ success: boolean }>("DELETE", `/api/v1/ol/watchlist/${watchlistId}`, { orgUserId });
}

// ── Fees & settlements ────────────────────────────────────────────────────────

export function getFeeEstimate(params: { currency: string; network?: string; transferType?: string }) {
  return fuzeReq<{ data: { fee: number; currency: string; network?: string } }>(
    "GET", "/api/v1/ol/fees/estimate", undefined, {
      currency: params.currency,
      ...(params.network && { network: params.network }),
      ...(params.transferType && { transferType: params.transferType }),
    }
  );
}

export function getSettlementOrders(params?: { page?: number; limit?: number }) {
  return fuzeReq<{ data: Array<{ orderId: number; status: string; amount: number; currency: string }> }>(
    "GET", "/api/v1/ol/settlements/orders", undefined, {
      ...(params?.page != null && { page: String(params.page) }),
      ...(params?.limit != null && { limit: String(params.limit) }),
    }
  );
}

export function listSettlements(params?: { page?: number; limit?: number }) {
  return fuzeReq<{ data: Array<{ id: string; amount: number; currency: string; status: string; createdAt: string }> }>(
    "GET", "/api/v1/ol/settlements", undefined, {
      ...(params?.page != null && { page: String(params.page) }),
      ...(params?.limit != null && { limit: String(params.limit) }),
    }
  );
}

// ── Remittances ────────────────────────────────────────────────────────────────

export function createRemittanceOriginator(params: {
  name: string;
  email?: string;
  phoneNumber?: string;
  address: string;
  nationality: string;
  country: string;
  idType: string;
  idNumber: string;
  type: "ORIGINATOR";
  clientIdentifier: string;
  dob: string;
}) {
  return fuzeReq<{ code: number; data: RemittanceThirdParty; error: unknown }>(
    "POST", "/api/v1/payment/remittance/third-party/create", params
  );
}

export function fetchRemittanceOriginator(clientIdentifier: string) {
  return fuzeReq<{ code: number; data: RemittanceThirdParty; error: unknown }>(
    "POST", "/api/v1/payment/remittance/third-party/fetch", { clientIdentifier }
  );
}

export function createRemittanceBeneficiary(params: {
  thirdPartyClientIdentifier: string;
  clientIdentifier: string;
  currency: string;
  accountType: string;
  country: string;
  enableAccountVerification?: boolean;
  accountData: Record<string, unknown>;
}) {
  return fuzeReq<{ code: number; data: RemittanceBeneficiary; error: unknown }>(
    "POST", "/api/v1/payment/remittance/third-party/account/create", params
  );
}

export function fetchRemittanceBeneficiary(clientIdentifier: string) {
  return fuzeReq<{ code: number; data: RemittanceBeneficiary; error: unknown }>(
    "POST", "/api/v1/payment/remittance/third-party/account/fetch", { clientIdentifier }
  );
}

export function createRemittanceOriginatorWithBeneficiary(params: {
  name: string;
  email?: string;
  phoneNumber?: string;
  address: string;
  nationality: string;
  country: string;
  idType: string;
  idNumber: string;
  type: "ORIGINATOR";
  clientIdentifier: string;
  dob: string;
  account: {
    currency: string;
    accountType: string;
    country: string;
    clientIdentifier: string;
    enableAccountVerification?: boolean;
    accountData: Record<string, unknown>;
  };
}) {
  return fuzeReq<{ code: number; data: RemittanceThirdParty; error: unknown }>(
    "POST", "/api/v1/payment/remittance/third-party/create-with-account", params
  );
}

export function createRemittanceQuote(params: {
  fromCurrency: string;
  toCurrency: string;
  quantity: number;
  orgUserId: string;
}) {
  return fuzeReq<{ code: number; data: RemittanceQuote }>("POST", "/api/v1/payment/remittance/quote", params);
}

export function executeRemittancePayment(params: { quoteId: number; quantity: number; orgUserId: string }) {
  return fuzeReq<{ code: number; data: RemittancePayment }>("POST", "/api/v1/payment/remittance/payment", params);
}

export function fetchRemittancePayment(uuid: string) {
  return fuzeReq<{ code: number; data: RemittancePayment }>("POST", "/api/v1/payment/remittance/payment/fetch", { uuid });
}

export function getRemittanceBalance() {
  return fuzeReq<{ code: number; data: RemittanceBalance }>("GET", "/api/v1/payment/remittance/org/balance");
}

export function verifyBeneficiary(params: {
  receiverClientIdentifier: string;
  currency: string;
  accountType: string;
  country: string;
  accountData: {
    accountNumber?: string;
    ifscCode?: string;
    upiId?: string;
    name: string;
    bankAccountType?: string;
  };
}) {
  return fuzeReq<{ code: number; data: BeneficiaryVerification }>(
    "POST", "/api/v1/payment/remittance/beneficiary/verify", params
  );
}

export function createRemittancePayout(params: {
  email: string;
  name: string;
  address: string;
  nationality: string;
  idType: string;
  idNumber: string;
  senderClientIdentifier: string;
  country: string;
  dob: string;
  clientOrderId: string;
  amount: number;
  purpose: string;
  account: {
    receiverClientIdentifier: string;
    currency: string;
    accountType: string;
    country: string;
    phoneNumber?: string;
    address?: string;
    dob?: string;
    nationality?: string;
    idType?: string;
    idNumber?: string;
    accountData: {
      accountNumber?: string;
      ifscCode?: string;
      upiId?: string;
      name: string;
      bankAccountType?: string;
    };
  };
}) {
  return fuzeReq<{ code: number; data: RemittancePayout }>(
    "POST", "/api/v1/payment/remittance/payout/create-with-details", params
  );
}

export function createRemittancePayoutToBeneficiary(params: {
  currency: string;
  amount: number;
  clientOrderId: string;
  clientIdentifier: string;
  purpose: string;
  [key: string]: unknown;
}) {
  return fuzeReq<{ code: number; data: RemittancePayout; error: unknown }>(
    "POST", "/api/v1/payment/remittance/payout/create", params
  );
}

export function listRemittancePayouts(clientIdentifier: string) {
  return fuzeReq<{ code: number; data: RemittancePayout[]; error: unknown }>(
    "POST", "/api/v1/payment/remittance/payout/list/", { clientIdentifier }
  );
}

export function fetchRemittancePayout(clientOrderId: string) {
  return fuzeReq<{ code: number; data: { status: PayoutStatus; currency: string; amountDeducted: number; amountSent: number; createdAt: string; referenceId: string; paymentReferenceNumber?: string; paymentDate?: string; clientOrderId: string } }>(
    "POST", "/api/v1/payment/remittance/payout/fetch/", { clientOrderId }
  );
}

export function getBankingDirectory(country: string) {
  return fuzeReq<{ data: unknown }>("GET", `/api/v1/payment/remittance/bank-details/${country}`);
}

// --- Payment gateway / Fuze Pay ------------------------------------------------

export function createGatewayCustomer(params: {
  clientIdentifier: string;
  email?: string;
  type: "THIRD_PARTY";
  sumsubToken?: string;
  kycData: Record<string, unknown>;
  [key: string]: unknown;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayCustomer; error: unknown }>(
    "POST", "/api/v1/payment/gateway/third-party/create/", params
  );
}

export function updateGatewayCustomerKyc(params: {
  clientIdentifier: string;
  kycData: Record<string, unknown>;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayCustomer; error: unknown }>(
    "POST", "/api/v1/payment/gateway/third-party/update", params
  );
}

export function getGatewayKycFileUploadLink(params: {
  clientIdentifier: string;
  fileName: string;
  docCategory: string;
  docSubCategory?: string;
  docdescription?: string;
}) {
  return fuzeReq<{ code: number; data: { uuid: string; expiryTime: number; url: string }; error: unknown }>(
    "POST", "/api/v1/payment/gateway/third-party/kyc-files/generate-upload-link", params
  );
}

export function fetchGatewayCustomer(clientIdentifier: string) {
  return fuzeReq<{ code: number; data: FuzeGatewayCustomer; error: unknown }>(
    "POST", "/api/v1/payment/gateway/third-party/fetch", { clientIdentifier }
  );
}

export function listGatewayCustomers(params?: {
  query?: string;
  pageSize?: number;
  pageNumber?: number;
  status?: string;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayCustomer[]; error: unknown }>(
    "POST", "/api/v1/payment/gateway/third-party/list", params ?? {}
  );
}

export function listGatewaySupportedAssets() {
  return fuzeReq<{ code: number; data: Array<{ asset: string; chainsAndNetworks: Array<{ chain: string; network: string }>; description?: string; policies?: Record<string, unknown> }>; error: unknown }>(
    "GET", "/api/v1/asset/assets"
  );
}

export function getGatewayConversionRate(params: {
  symbol: string;
  operation: "BUY" | "SELL";
  quantity?: number;
  quoteQuantity?: number;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayQuote; error: unknown }>(
    "POST", "/api/v1/payment/conversion-rate", params
  );
}

export function createGatewayDepositWallet(params: {
  clientIdentifier: string;
  symbol: string;
  chain: string;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayDepositWallet; error: unknown }>(
    "POST", "/api/v1/payment/gateway/third-party/deposit-wallet/create", params
  );
}

export function fetchGatewayDepositWallet(params: {
  clientIdentifier: string;
  symbol: string;
  chain: string;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayDepositWallet; error: unknown }>(
    "POST", "/api/v1/payment/gateway/third-party/deposit-wallet/fetch", params
  );
}

export function listGatewayDepositWallets(params?: {
  clientIdentifier?: string;
  symbol?: string;
  chain?: string;
  status?: string;
  pageSize?: number;
  pageNumber?: number;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayDepositWallet[]; error: unknown }>(
    "POST", "/api/v1/payment/gateway/third-party/deposit-wallet/list", params ?? {}
  );
}

export function createGatewayPayin(params: {
  clientIdentifier: string;
  symbol: string;
  chain?: string;
  quantity?: number;
  quoteQuantity?: number;
  clientOrderId?: string;
  quoteId?: number;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayPayment; error: unknown }>(
    "POST", "/api/v1/payment/gateway/payin/create", params
  );
}

export function fetchGatewayPayin(clientOrderId: string) {
  return fuzeReq<{ code: number; data: FuzeGatewayPayment; error: unknown }>(
    "POST", "/api/v1/payment/gateway/payin/status/", { clientOrderId }
  );
}

export function listGatewayPayins(params?: {
  clientIdentifier?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  pageSize?: number;
  pageNumber?: number;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayPayment[]; error: unknown }>(
    "POST", "/api/v1/payment/gateway/payin/list/", params ?? {}
  );
}

export function createGatewayPayout(params: {
  clientIdentifier: string;
  address: string;
  chain: string;
  symbol: string;
  quantity?: number;
  quoteQuantity?: number;
  quoteId?: number;
  clientOrderId?: string;
  parentClientOrderId?: string;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayPayment; error: unknown }>(
    "POST", "/api/v1/payment/gateway/payout/create", params
  );
}

export function fetchGatewayPayout(clientOrderId: string) {
  return fuzeReq<{ code: number; data: FuzeGatewayPayment; error: unknown }>(
    "POST", "/api/v1/payment/gateway/payout/status/", { clientOrderId }
  );
}

export function listGatewayPayouts(params?: {
  clientIdentifier?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  pageSize?: number;
  pageNumber?: number;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayPayment[]; error: unknown }>(
    "POST", "/api/v1/payment/gateway/payout/list/", params ?? {}
  );
}

export function createGatewayRefund(params: {
  clientIdentifier: string;
  address: string;
  chain: string;
  symbol: string;
  parentClientOrderId: string;
  quantity?: number;
  quoteId?: number;
  clientOrderId?: string;
}) {
  return createGatewayPayout(params);
}

export function createGatewayPayoutQuote(params: {
  clientIdentifier: string;
  symbol: string;
  chain: string;
  address?: string;
  quantity?: number;
  quoteQuantity?: number;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayQuote; error: unknown }>(
    "POST", "/api/v1/payment/gateway/payout/quote", params
  );
}

export function createGatewayPayinQuote(params: {
  clientIdentifier: string;
  symbol: string;
  chain?: string;
  quantity?: number;
  quoteQuantity?: number;
}) {
  return fuzeReq<{ code: number; data: FuzeGatewayQuote; error: unknown }>(
    "POST", "/api/v1/payment/gateway/payin/quote", params
  );
}

export function whitelistGatewayWallet(params: {
  clientIdentifier: string;
  address: string;
  asset: string;
  chain: string;
  walletType: "DECENTRALIZED" | "CUSTODIAL";
  memo?: string;
  nickname?: string;
  vaspDid?: string;
  vaspName?: string;
  vaspWebsite?: string;
  ownershipProof: Record<string, unknown>;
  [key: string]: unknown;
}) {
  return fuzeReq<{ code: number; data: unknown; error: unknown }>(
    "POST", "/api/v1/payment/gateway/wallet/whitelist", params
  );
}

export function getGatewayAccountBalances() {
  return fuzeReq<{ code: number; data: Array<{ currency: string; balance: number }>; error: unknown }>(
    "GET", "/api/v1/payment/gateway/account/balances"
  );
}

export function listGatewayAccountTransactions(params?: {
  currency?: string;
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  pageNumber?: number;
}) {
  return fuzeReq<{ code: number; data: unknown[]; error: unknown }>(
    "POST", "/api/v1/payment/gateway/account/transactions", params ?? {}
  );
}
