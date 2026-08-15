/**
 * Bitrefill REST API v2 client — server-side only.
 * Base URL: https://api.bitrefill.com/v2
 * Auth:     Authorization: Bearer <BITREFILL_API_KEY>
 *
 * Products have two denomination models:
 *   - Fixed: product.packages array with set values
 *   - Flexible: product.range { min, max, step } — caller chooses amount
 *
 * Typical purchase flow:
 *   1. searchProducts / getProducts  → pick product + package
 *   2. createInvoice                 → get payment.address + payment.price
 *   3. Send USDC to payment.address  → via arcKit / on-chain transfer
 *   4. Poll getInvoice until complete → orders[].redemptionInfo.code
 */

const BASE = "https://api.bitrefill.com/v2";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BitrefillPackage = {
  id: string;
  value: number;          // denomination, e.g. 15
  currencyCode: string;   // "USD"
  priceInUsd: number;     // USDC cost (usually == value for USD gift cards)
  eurosPrice?: number;
  satoshiPrice?: number;
};

export type BitrefillProduct = {
  id: string;             // "netflix-us"
  name: string;           // "Netflix Gift Card (US)"
  slug: string;
  type: string;           // "giftcard" | "topup" | ...
  category: string;       // "entertainment" | "shopping" | "gaming" | ...
  currency: string;       // "USD"
  countries: string[];
  packages: BitrefillPackage[];
  /** When false the product uses range pricing instead of fixed packages */
  fixedPackages: boolean;
  range?: { min: number; max: number; step: number };
  logoImage: string;      // URL to brand logo
  logoImageHeight?: number;
  logoImageWidth?: number;
  description?: string;
  featured?: boolean;
};

export type BitrefillPaymentInfo = {
  address: string;        // crypto payment address / invoice
  price: number;          // amount to send in the payment currency
  currency: string;       // "USDC" | "BTC" | ...
  altcoinCode?: string;
  /** Lightning invoice if applicable */
  lightningInvoice?: string;
  /** Satoshi equivalent */
  satoshiPrice?: number;
};

export type BitrefillOrder = {
  id: string;
  status: string;
  productId: string;
  productName?: string;
  value: number;
  currency: string;
  /** Redemption code — present when status is "delivered" or "complete" */
  redemptionInfo?: {
    codeType: string;    // "CODE" | "LINK" | "PIN"
    code?: string;       // the gift card code
    pin?: string;
    serial?: string;
    instructions?: string;
    link?: string;
  };
  pinInfo?: {
    type: string;
    instructions: string;
    Pin?: string;
    Code?: string;
  };
};

export type BitrefillInvoice = {
  id: string;
  status:
    | "unpaid"
    | "payment_detected"
    | "payment_confirmed"
    | "pending"
    | "complete"
    | "failed"
    | "expired";
  payment?: BitrefillPaymentInfo;
  orders?: BitrefillOrder[];
  expirationTime?: string;
};

export type ProductListResponse = {
  data: BitrefillProduct[];
  total?: number;
  hasMore?: boolean;
};

// ── Auth helper ───────────────────────────────────────────────────────────────

function authHeader(): Record<string, string> {
  const key = process.env.BITREFILL_API_KEY;
  if (!key) throw new Error("BITREFILL_API_KEY is not set");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export function isBitrefillConfigured(): boolean {
  return Boolean(process.env.BITREFILL_API_KEY);
}

// ── Products ──────────────────────────────────────────────────────────────────

/**
 * Search products by free-text query.
 * Returns matching products sorted by relevance.
 */
export async function searchProducts(opts: {
  q: string;
  country?: string;
  category?: string;
  limit?: number;
  start?: number;
}): Promise<ProductListResponse> {
  const params = new URLSearchParams({ q: opts.q });
  if (opts.country)  params.set("country",  opts.country);
  if (opts.category) params.set("category", opts.category);
  if (opts.limit)    params.set("limit",    String(opts.limit));
  if (opts.start)    params.set("start",    String(opts.start));

  const res = await fetch(`${BASE}/products/search?${params}`, {
    headers: authHeader(),
    next: { revalidate: 300 },  // 5-minute Next.js cache
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Bitrefill search error ${res.status}: ${msg}`);
  }
  return res.json();
}

/**
 * Browse the product catalog with optional filters.
 */
export async function getProducts(opts?: {
  country?: string;
  category?: string;
  limit?: number;
  start?: number;
}): Promise<ProductListResponse> {
  const params = new URLSearchParams();
  if (opts?.country)  params.set("country",  opts.country);
  if (opts?.category) params.set("category", opts.category);
  if (opts?.limit)    params.set("limit",    String(opts.limit));
  if (opts?.start)    params.set("start",    String(opts.start));

  const qs = params.toString();
  const res = await fetch(`${BASE}/products${qs ? `?${qs}` : ""}`, {
    headers: authHeader(),
    next: { revalidate: 300 },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Bitrefill products error ${res.status}: ${msg}`);
  }
  return res.json();
}

/**
 * Get a single product with full package list.
 */
export async function getProduct(id: string): Promise<BitrefillProduct> {
  const res = await fetch(`${BASE}/products/${encodeURIComponent(id)}`, {
    headers: authHeader(),
    next: { revalidate: 300 },
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Bitrefill product ${id} error ${res.status}: ${msg}`);
  }
  return res.json();
}

// ── Invoices ──────────────────────────────────────────────────────────────────

/**
 * Payment method identifiers supported by Bitrefill.
 * "balance"      — use your pre-funded Bitrefill account balance (instant, AI-friendly)
 * "usdc_base"    — USDC on Base (EVM) — returns a Base address
 * "usdc_solana"  — USDC on Solana — returns a Solana address
 * "usdc_polygon" — USDC on Polygon
 * "bitcoin"      — BTC on-chain
 * "lightning"    — Lightning Network
 */
export type PaymentMethod =
  | "balance"
  | "usdc_base"
  | "usdc_solana"
  | "usdc_erc20"
  | "usdc_polygon"
  | "usdc_arbitrum"
  | "bitcoin"
  | "lightning"
  | "ethereum";

/**
 * Create a Bitrefill invoice (purchase request).
 *
 * @param paymentMethod  How the user will pay. Use "balance" for agent-initiated
 *                       purchases (requires funded Bitrefill account).
 *                       Use "usdc_base" / "usdc_solana" for crypto payment via arcKit.
 * @param autoPay        When true with payment_method="balance", pays immediately.
 *                       Ignored for crypto methods.
 */
export async function createInvoice(opts: {
  productId: string;
  packageId?: string;     // required for fixed-denomination products
  customValue?: number;   // required for range-priced products (e.g. mobile top-ups)
  paymentMethod: PaymentMethod;
  receiverEmail?: string; // email to deliver gift card code to
  /** Phone number for mobile top-up products (e.g. "+14155551234") */
  sendTo?: string;
  autoPay?: boolean;
}): Promise<BitrefillInvoice> {
  const item: Record<string, unknown> = {
    product_id: opts.productId,
  };
  if (opts.packageId)    item.package_id = opts.packageId;
  if (opts.sendTo)       item.send_to    = opts.sendTo;
  if (opts.customValue)  item.value       = opts.customValue;

  const body: Record<string, unknown> = {
    products:        [item],
    payment_method:  opts.paymentMethod,
    auto_pay:        opts.autoPay ?? false,
  };
  if (opts.receiverEmail) {
    body.receiver = { email: opts.receiverEmail };
  }

  const res = await fetch(`${BASE}/invoices`, {
    method:  "POST",
    headers: authHeader(),
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(
      (err as { message?: string })?.message ??
        `Bitrefill invoice error ${res.status}`,
    );
  }
  return res.json();
}

/**
 * Retrieve an invoice (to check payment status).
 * Poll this every 3–5 seconds after sending payment until status === "complete".
 */
export async function getInvoice(id: string): Promise<BitrefillInvoice> {
  const res = await fetch(`${BASE}/invoices/${encodeURIComponent(id)}`, {
    headers: authHeader(),
    cache: "no-store",
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Bitrefill invoice ${id} error ${res.status}: ${msg}`);
  }
  return res.json();
}

/**
 * Get a single order (contains redemption code when delivered).
 */
export async function getOrder(id: string): Promise<BitrefillOrder> {
  const res = await fetch(`${BASE}/orders/${encodeURIComponent(id)}`, {
    headers: authHeader(),
    cache: "no-store",
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Bitrefill order ${id} error ${res.status}: ${msg}`);
  }
  return res.json();
}

// ── Account ───────────────────────────────────────────────────────────────────

export async function getAccountBalance(): Promise<{
  balance: number;
  currency: string;
}> {
  const res = await fetch(`${BASE}/accounts/balance`, {
    headers: authHeader(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bitrefill balance error ${res.status}`);
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Maps Bitrefill product categories to Bluvfi UI tab keys.
 */
export const CATEGORY_MAP: Record<string, string> = {
  entertainment: "entertainment",
  streaming:     "entertainment",
  music:         "entertainment",
  gaming:        "gaming",
  games:         "gaming",
  shopping:      "shopping",
  retail:        "shopping",
  food:          "shopping",
  travel:        "travel",
  mobile:        "mobile",
  topup:         "mobile",
  "phone-topup": "mobile",
};

/**
 * Returns true when an invoice is in a terminal state.
 */
export function isInvoiceTerminal(status: BitrefillInvoice["status"]): boolean {
  return status === "complete" || status === "failed" || status === "expired";
}

/**
 * Extract the redemption code from a completed invoice's first order.
 */
export function extractCode(invoice: BitrefillInvoice): string | null {
  const order = invoice.orders?.[0];
  if (!order) return null;
  return (
    order.redemptionInfo?.code ??
    order.redemptionInfo?.pin ??
    order.pinInfo?.Pin ??
    order.pinInfo?.Code ??
    null
  );
}
