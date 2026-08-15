/**
 * Bitrefill CLI wrapper — server-side only.
 *
 * Uses `@bitrefill/cli` (≥ 0.3.0) for guest checkout without any Bitrefill account or API key.
 * This is the fallback path when BITREFILL_MCP_URL / BITREFILL_API_KEY are not configured.
 *
 * Guest checkout flow:
 *   search-products → get-product-details → buy-products --email → poll get-invoice-by-id
 *
 * The CLI binary is invoked as a child process:
 *   node node_modules/@bitrefill/cli/dist/index.js --json <command> [args]
 *
 * Reference: https://github.com/bitrefill/agents/releases/tag/v2.1.5
 */

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import type { MCPProduct, MCPPackage, MCPInvoice, MCPOrder } from "./bitrefill-mcp";

const execFileAsync = promisify(execFile);

// ── CLI runner ────────────────────────────────────────────────────────────────

/** Absolute path to the CLI entry point — works on Windows and Unix alike */
function getCliPath(): string {
  return path.join(process.cwd(), "node_modules/@bitrefill/cli/dist/index.js");
}

/**
 * Run a CLI command with --json flag and return the parsed JSON output.
 * stderr is collected but only surfaced on error.
 */
async function runCLI(command: string, args: string[]): Promise<unknown> {
  const cliPath = getCliPath();
  let stdout = "";
  let stderr = "";

  try {
    ({ stdout, stderr } = await execFileAsync(
      "node",
      [cliPath, "--json", command, ...args],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (err: any) {
    // execFile rejects on non-zero exit or timeout
    const msg = err?.stderr || err?.message || "CLI process failed";
    throw new Error(`Bitrefill CLI error (${command}): ${msg}`);
  }

  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`Bitrefill CLI returned no output (${command}). stderr: ${stderr}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Bitrefill CLI returned invalid JSON (${command}): ${raw.slice(0, 200)}`);
  }
}

// ── Category → intent mapping ─────────────────────────────────────────────────

/**
 * Map our category slugs to Bitrefill CLI "intent" strings.
 * The CLI search-products requires --intent (free-text purchase intent).
 */
function categoryToIntent(category?: string): string {
  const map: Record<string, string> = {
    entertainment: "streaming entertainment video",
    gaming:        "gaming games in-game currency",
    shopping:      "shopping retail online marketplace",
    food:          "food delivery restaurants groceries",
    topup:         "mobile phone top-up refill prepaid",
    esim:          "esim data plan travel internet",
    vpn:           "vpn privacy security",
    travel:        "travel flights hotels accommodation",
  };
  if (!category) return "gift cards digital products";
  return map[category.toLowerCase()] ?? category;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function cliSearchProducts(opts: {
  query?: string;
  country?: string;
  category?: string;
  limit?: number;
}): Promise<MCPProduct[]> {
  const args: string[] = [];

  // search-products requires --intent
  args.push("--intent", categoryToIntent(opts.category));
  if (opts.query)   args.push("--query",    opts.query);
  if (opts.country) args.push("--country",  opts.country);
  if (opts.limit)   args.push("--per_page", String(opts.limit));

  const raw = await runCLI("search-products", args);
  return normalizeCLIProducts(raw);
}

export async function cliGetProductDetails(productId: string): Promise<MCPProduct> {
  const raw = await runCLI("get-product-details", ["--product_id", productId]);
  return normalizeCLIProduct(raw as any);
}

export async function cliBuyProducts(opts: {
  productId: string;
  /** package_value from get-product-details (e.g. "30") */
  packageId: string;
  /** "usdc_base" | "usdc_solana" | "bitcoin" | … */
  paymentMethod?: string;
  /** Phone number in E.164 for top-ups */
  refillInput?: string;
  /** Guest checkout — code delivered to this email */
  recipientEmail?: string;
  recipientName?: string;
  returnPaymentLink?: boolean;
  /** Optional gift delivery — Bitrefill emails the product to the recipient */
  gift?: {
    recipient_name: string;
    recipient_email: string;
    sender_name: string;
    message?: string;
    theme?: string;
    send_date?: string;
  };
}): Promise<MCPInvoice> {
  const cartItem: Record<string, unknown> = {
    product_id:   opts.productId,
    package_value: opts.packageId,
  };

  if (opts.refillInput) {
    cartItem.refill_input = opts.refillInput;
  }

  // Explicit gift object takes priority; fall back to simple guest-checkout wrapping
  if (opts.gift) {
    cartItem.gift = opts.gift;
  } else if (opts.recipientEmail) {
    cartItem.gift = {
      recipient_email: opts.recipientEmail,
      recipient_name:  opts.recipientName ?? opts.recipientEmail.split("@")[0],
      sender_name:     "Bluvfi",
    };
  }

  const args: string[] = [
    "--cart_items",     JSON.stringify([cartItem]),
    "--payment_method", opts.paymentMethod ?? "usdc_base",
  ];

  // --email sets the invoice notification address (guest checkout receipt)
  if (opts.recipientEmail) {
    args.push("--email", opts.recipientEmail);
  }

  if (opts.returnPaymentLink) {
    args.push("--return_payment_link", "true");
  }

  const raw = await runCLI("buy-products", args);
  return normalizeCLIInvoice(raw);
}

export async function cliGetInvoice(invoiceId: string): Promise<MCPInvoice> {
  const raw = await runCLI("get-invoice-by-id", ["--invoice_id", invoiceId]);
  return normalizeCLIInvoice(raw);
}

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeCLIProducts(raw: unknown): MCPProduct[] {
  if (!raw) return [];
  const obj = raw as any;
  const items: any[] = Array.isArray(obj)
    ? obj
    : obj.products ?? obj.data ?? obj.results ?? [];
  if (!Array.isArray(items)) return [];
  return items.map(normalizeCLIProduct);
}

function normalizeCLIProduct(p: any): MCPProduct {
  // CLI uses _id; MCP uses id/slug — normalize to id
  const id = p._id ?? p.id ?? p.slug ?? "";

  // CLI never returns a logo_url. The Cloudinary /v1/products/{id}/logo path
  // always returns the same d_operator.png placeholder (not a real logo).
  // Leave logo_url undefined so the UI can show a Google Favicon or emoji instead.
  const logo_url = p.logo_url ?? p.logoImage ?? p.image ?? p.imageUrl ?? undefined;

  return {
    id,
    name:           p.name ?? p.title ?? id,
    category:       Array.isArray(p.categories) ? p.categories[0] : (p.category ?? p.type ?? ""),
    currency:       p.currency ?? "USD",
    countries:      Array.isArray(p.countries) ? p.countries : [],
    logo_url,
    packages:       Array.isArray(p.packages) ? p.packages.map((pkg: any) => normCLIPkg(pkg, p.price_rate)) : undefined,
    range:
      p.range
        ? { ...p.range, price_rate: p.range.price_rate ?? p.price_rate }
        : p.min_value != null
          ? { min: Number(p.min_value), max: Number(p.max_value), step: Number(p.value_step ?? 1), price_rate: Number(p.price_rate) || undefined }
          : undefined,
    recipient_type:   p.recipient_type?.trim() || undefined,
    account_id_name:  p.account_id_name?.trim() || undefined,
    account_id_regex: p.account_id_regex?.trim() || undefined,
    in_stock:        p.in_stock ?? true,
    prepayment:      p.prepayment ?? undefined,
    subtitles:       p.subtitles ?? undefined,
    descriptions:    p.descriptions ?? undefined,
    instructions:    p.instructions ?? undefined,
    termsConditions: p.termsConditions ?? p.terms_conditions ?? undefined,
    ratings:         p.ratings ?? undefined,
    reviews:         Array.isArray(p.reviews) ? p.reviews : undefined,
    payment_methods: p.payment_methods ?? undefined,
  };
}

function normCLIPkg(p: any, productPriceRate?: number): MCPPackage {
  // CLI packages use package_value as the denomination
  const package_value = String(p.package_value ?? p.value ?? "");

  // price_usd: use the denomination value when already USD, or convert via price_rate.
  // p.payment_price is the CRYPTO payment amount (e.g. 0.016 BTC) — NOT a USD price.
  const isUSD = (p.package_currency ?? "USD") === "USD";
  const priceRate = p.price_rate ?? productPriceRate;
  const price_usd: number | undefined =
    p.price_usd ?? p.priceInUsd ??
    (isUSD
      ? Number(package_value) || undefined
      : priceRate ? Number(package_value) * priceRate || undefined : undefined);

  return {
    package_id:    p.package_id ?? package_value,
    package_value,
    price_usd,
  };
}

function normalizeCLIInvoice(raw: unknown): MCPInvoice {
  if (!raw) throw new Error("Empty invoice response from Bitrefill CLI");
  const obj = raw as any;
  // buy-products wraps the invoice under "response"; some paths use "invoice" or "data"
  const inv = obj.response ?? obj.invoice ?? obj.data ?? obj;

  return {
    invoice_id:         inv.invoice_id ?? inv.id ?? "",
    status:             inv.status ?? "unpaid",
    payment_link:       inv.payment_link ?? undefined,
    x402_payment_url:   inv.x402_payment_url ?? undefined,
    payment_info:       normalizeCLIPaymentInfo(inv),
    expiration_minutes: inv.expiration_minutes ?? inv.expiresInMinutes ?? undefined,
    orders:             Array.isArray(inv.orders) ? inv.orders.map(normCLIOrder) : undefined,
    agent_instructions: obj.agent_instructions ?? inv.agent_instructions ?? undefined,
    esim_install_links: inv.esim_install_links ?? undefined,
  };
}

function normalizeCLIPaymentInfo(inv: any) {
  if (inv.payment_info?.address) return inv.payment_info;
  if (inv.payment?.address) {
    return {
      address:  inv.payment.address,
      amount:   inv.payment.price ?? inv.payment.amount,
      currency: inv.payment.currency ?? "USDC",
    };
  }
  return undefined;
}

function normCLIOrder(o: any): MCPOrder {
  return {
    order_id:          o.order_id ?? o.id ?? "",
    status:            o.status ?? "",
    redemption_info:   o.redemption_info ?? undefined,
    esim_install_link: o.esim_install_link ?? undefined,
  };
}
