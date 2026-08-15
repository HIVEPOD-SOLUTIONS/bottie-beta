/**
 * Bitrefill eCommerce MCP client — server-side only.
 *
 * Authentication (in priority order):
 *
 *   1. BITREFILL_MCP_URL      — explicit MCP base URL, may include API key in path
 *                               e.g. https://api.bitrefill.com/mcp/YOUR_API_KEY
 *   2. BITREFILL_API_KEY      — shorthand; builds https://api.bitrefill.com/mcp/KEY
 *   3. CLI OAuth token        — reads ~/.config/bitrefill-cli/api.bitrefill.com.v1.json
 *                               and mints a fresh Bearer token via client_credentials grant.
 *                               This is how the @bitrefill/cli authenticates under the hood.
 *                               No API key or Bitrefill account required.
 *
 * The client_credentials grant uses the CLI's registered client_id with
 * token_endpoint_auth_method=none (no secret). It yields a 6-hour access token.
 * Tokens are cached in-process and refreshed automatically on expiry.
 *
 * BITREFILL_AFFILIATE_CODE is appended as ?ref=CODE to all paths where applicable.
 *
 * Reference: https://github.com/bitrefill/agents/releases/tag/v2.1.5
 */

import fs from "fs";
import path from "path";
import os from "os";
import {
  cliSearchProducts,
  cliGetProductDetails,
  cliBuyProducts,
  cliGetInvoice,
} from "./bitrefill-cli";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ── OAuth token management ────────────────────────────────────────────────────

const BITREFILL_MCP_BASE = "https://api.bitrefill.com/mcp";
const BITREFILL_TOKEN_URL = "https://api.bitrefill.com/oauth/mcp/token";
const BITREFILL_REGISTER_URL = "https://api.bitrefill.com/oauth/mcp/register";
/** Path where the @bitrefill/cli caches its OAuth client + tokens */
const CLI_CACHE_FILE = path.join(os.homedir(), ".config", "bitrefill-cli", "api.bitrefill.com.v1.json");

interface CliCache {
  clientInfo?: { client_id?: string };
  tokens?: { access_token?: string; expires_in?: number; scope?: string; issued_at?: number };
}

/** In-process token cache: { access_token, expiresAt (ms epoch) } */
let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * In-process client_id cache.
 * On Vercel each cold start is a fresh process, so the CLI cache file is never
 * present. Without this, every token refresh re-registers a new anonymous client
 * which quickly hits the 429 rate limit on the registration endpoint.
 *
 * Resolution order:
 *   1. BITREFILL_CLIENT_ID env var  (stable across Vercel deployments)
 *   2. In-process module variable   (stable for the lifetime of one warm instance)
 *   3. CLI cache file               (only present when running locally with @bitrefill/cli)
 *   4. Dynamic client registration  (last resort — may 429 under load)
 */
let _cachedClientId: string | null = null;

async function getClientId(): Promise<string> {
  // 1. Env var — best on Vercel: set BITREFILL_CLIENT_ID in Vercel dashboard
  const envClientId = process.env.BITREFILL_CLIENT_ID;
  if (envClientId) return envClientId;

  // 2. In-process cache (survives token refreshes within the same warm instance)
  if (_cachedClientId) return _cachedClientId;

  // 3. CLI cache file (local dev with @bitrefill/cli installed)
  try {
    const raw = fs.readFileSync(CLI_CACHE_FILE, "utf-8");
    const cache: CliCache = JSON.parse(raw);
    if (cache.clientInfo?.client_id) {
      _cachedClientId = cache.clientInfo.client_id;
      return _cachedClientId;
    }
  } catch { /* file not found or unreadable — fall through */ }

  // 4. Dynamic client registration (no secret required)
  const res = await fetch(BITREFILL_REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "bluvfi",
      grant_types: ["client_credentials"],
      token_endpoint_auth_method: "none",
      scope: "mcp",
      redirect_uris: [process.env.NEXT_PUBLIC_APP_URL ?? "https://www.bluvfi.xyz"],
    }),
  });
  if (!res.ok) throw new Error(`Bitrefill client registration failed: ${res.status}`);
  const data = await res.json() as { client_id: string };
  _cachedClientId = data.client_id;
  return _cachedClientId;
}

/**
 * Mint or return a cached Bearer token via the client_credentials grant.
 * Tokens are valid for 6 hours; we refresh 5 min early.
 */
async function getBearerToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresAt > now) return _cachedToken.token;

  const clientId = await getClientId();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    scope: "mcp",
    resource: "https://api.bitrefill.com/",
  });

  const res = await fetch(BITREFILL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bitrefill token error: ${res.status} ${err}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  const expiresAt = now + (data.expires_in - 300) * 1000; // refresh 5 min early
  _cachedToken = { token: data.access_token, expiresAt };
  return data.access_token;
}

// ── MCP URL / configuration ───────────────────────────────────────────────────

function buildMcpUrl(): string {
  const explicit  = (process.env.BITREFILL_MCP_URL ?? "").trim().replace(/\/$/, "");
  const apiKey    = (process.env.BITREFILL_API_KEY  ?? "").trim();
  const affiliate = (process.env.BITREFILL_AFFILIATE_CODE ?? "").trim();

  let base = explicit;
  if (!base && apiKey) base = `${BITREFILL_MCP_BASE}/${apiKey}`;
  // No API key / URL → use OAuth path (getBearerToken() + BITREFILL_MCP_BASE)
  if (!base) base = BITREFILL_MCP_BASE;

  if (affiliate) {
    const url = new URL(base);
    if (!url.searchParams.has("ref")) url.searchParams.set("ref", affiliate);
    return url.toString();
  }
  return base;
}

const MCP_URL = buildMcpUrl();

/**
 * True only when an API key is embedded in the URL path (not just a bare base URL).
 * e.g. https://api.bitrefill.com/mcp/YOUR_KEY  → true
 *      https://api.bitrefill.com/mcp            → false (use OAuth Bearer)
 *      https://api.bitrefill.com/mcp?ref=CODE   → false (use OAuth Bearer)
 */
const USE_API_KEY_PATH = (() => {
  const explicit = (process.env.BITREFILL_MCP_URL ?? "").trim();
  const apiKey   = (process.env.BITREFILL_API_KEY  ?? "").trim();
  if (apiKey) return true; // explicit API key env var
  if (!explicit) return false;
  try {
    const url = new URL(explicit);
    // Has a non-trivial path segment after /mcp (the key)
    return url.pathname.replace(/^\/mcp\/?/, "").length > 0;
  } catch { return false; }
})();

/**
 * Always true — either via API key path or OAuth client_credentials.
 * CLI is kept as a fallback only for the prepayment bill-pay flow.
 */
export function isMCPConfigured(): boolean {
  return true;
}

export function isConfigured(): boolean {
  return true;
}

// ── MCP client factory ────────────────────────────────────────────────────────

/**
 * Creates a fresh MCP client connected to the Bitrefill server.
 * Uses API-key-in-path auth when BITREFILL_API_KEY / BITREFILL_MCP_URL is set,
 * otherwise mints a Bearer token via client_credentials and passes it as a header.
 */
async function createClient(): Promise<Client> {
  const client = new Client(
    { name: "bluvfi", version: "1.0.0" },
    { capabilities: {} },
  );

  let transport: StreamableHTTPClientTransport;

  if (USE_API_KEY_PATH) {
    // API key embedded in URL path — no Authorization header needed
    transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  } else {
    // OAuth Bearer token
    const token = await getBearerToken();
    transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
  }

  await client.connect(transport);
  return client;
}

/**
 * Call one Bitrefill MCP tool and return the parsed result.
 * Handles initialize handshake, session IDs, SSE, and TOON format automatically.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = await createClient();
  try {
    const result = await client.callTool({ name, arguments: args });
    return parseToolResult(result);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Extract usable data from an MCP CallToolResult.
 * Handles JSON content items, TOON text content items, and raw objects.
 */
function parseToolResult(result: unknown): unknown {
  const r = result as {
    content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
    isError?: boolean;
  };

  if (r?.isError) {
    const msg = r.content?.find((c) => c.type === "text")?.text ?? "MCP tool error";
    throw new Error(msg);
  }

  const items = r?.content ?? [];
  for (const item of items) {
    if (item.type === "text" && item.text) {
      // Try JSON first — buy-products always returns JSON
      try {
        return JSON.parse(item.text);
      } catch {
        // TOON format (structured text for AI) — parse to structured object
        return parseToon(item.text);
      }
    }
    if (item.type === "resource" || item.type === "object") {
      return (item as any).resource ?? item;
    }
  }
  return r;
}

/**
 * Parse Bitrefill TOON (Text or Object Notation) into a JS object.
 *
 * search-products returns:
 *   categories[N]{...}:\n  val,...\nproducts[N]:\n  - _id: ...\n    key: val\n  - ...
 *
 * get-product-details returns a similar single-product block.
 */
function parseToon(text: string): unknown {
  // Embedded JSON block
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch { /* continue */ }
  }
  try { return JSON.parse(text); } catch { /* continue */ }

  // ── Bitrefill TOON: search-products response ──────────────────────────────
  // Format: sections separated by blank lines or section headers like "products[N]:"
  if (text.includes("products[")) {
    return parseToonProducts(text);
  }

  // ── Bitrefill TOON: get-product-details response ──────────────────────────
  // Starts with flat key-value pairs then nested sections (packages, payment_methods, etc.)
  if (text.includes("packages[") || text.includes("payment_methods:")) {
    const product = parseToonProductDetails(text);
    if (product) return [product];
  }

  // ── Bitrefill TOON: get-invoice-by-id response ───────────────────────────
  // MUST come before the _id: check — invoice TOON has `order_id:` and `invoice_id:`
  // which both contain `_id:`, causing parseToonProductBlock to misfire.
  //
  // Format:
  //   invoice_id: 653d0682-…
  //   invoice_status: unpaid
  //   payment_info:
  //     address: 0xABC…
  //     altcoinPrice: "0.08"
  //   orders[1]:
  //     - order_id: abc123
  if (text.includes("invoice_id:") || text.includes("invoice_status:")) {
    const { obj } = parseToonFlatObject(text);
    if (Object.keys(obj).length > 0) return obj;
  }

  // ── Product block (get-product-details / search-products single block) ────
  // `_id:` used by legacy product TOON; `package_id:` by package sections.
  // Never fire this on invoice TOON (guarded above).
  if (text.includes("_id:") || text.includes("package_id:")) {
    const product = parseToonProductBlock(text);
    if (product) return [product];
  }

  // ── Generic flat key-value (any other tool) ───────────────────────────────
  if (/^\w[\w_]*:/.test(text.trimStart())) {
    const { obj } = parseToonFlatObject(text);
    if (Object.keys(obj).length > 0) return obj;
  }

  // Legacy: "**Name (id)**" style blocks
  const products: Record<string, unknown>[] = [];
  const blocks = text.split(/\n(?=\*\*|\d+\.\s)/);
  for (const block of blocks) {
    const obj = parseToonBlock(block);
    if (obj && (obj.id || obj.name)) products.push(obj);
  }
  if (products.length > 0) return products;

  return { raw: text };
}

/**
 * Generic TOON flat-object parser for tools like get-invoice-by-id.
 *
 * Handles:
 *   key: scalar_value           → string / number / boolean
 *   key:                        → nested object (indented block follows)
 *     sub_key: value
 *   key[N]:                     → array of objects (list items follow)
 *     - item_key: value
 *       nested_key:
 *         sub: value
 */
function parseToonFlatObject(
  text: string,
  startLine = 0,
  minIndent = 0,
): { obj: Record<string, unknown>; endLine: number } {
  const lines = text.split("\n");
  const obj: Record<string, unknown> = {};
  let i = startLine;

  while (i < lines.length) {
    const raw = lines[i];
    const indent = (raw.match(/^(\s*)/)?.[1].length ?? 0);

    // Stop if we've dedented past caller's indent level
    if (raw.trim() && indent < minIndent) break;

    // Skip blank lines
    if (!raw.trim()) { i++; continue; }

    // List-item continuation (indented "-" under an array header)
    const listItem = raw.match(/^(\s*)-\s+(\w[\w_]*):\s*(.*)$/);
    if (listItem) { i++; continue; } // handled by array section below

    // Key-value pair: "  key: value" OR "  key[N]: value"
    const kvMatch = raw.match(/^(\s*)([a-zA-Z_]\w*)(?:\[(\d+)\])?:\s*(.*)$/);
    if (!kvMatch) { i++; continue; }

    const [, , key, bracketN, rest] = kvMatch;
    const keyIndent = kvMatch[1].length;

    if (keyIndent < minIndent) break; // dedented — stop

    const isArray = bracketN !== undefined;

    if (rest.trim()) {
      // Inline scalar value
      obj[key] = coerceToonScalar(rest.trim());
      i++;
    } else {
      // Look ahead at next non-empty line to decide: object or array
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;

      const nextRaw = lines[j] ?? "";
      const nextIndent = (nextRaw.match(/^(\s*)/)?.[1].length ?? 0);
      const isListStart = /^\s*-\s+/.test(nextRaw);

      if (nextIndent <= keyIndent || j >= lines.length) {
        // Empty section
        obj[key] = isArray ? [] : {};
        i++;
      } else if (isListStart || isArray) {
        // Array of objects: each item starts with "  - first_key: val"
        const items: Record<string, unknown>[] = [];
        i++;
        while (i < lines.length) {
          const itemRaw = lines[i];
          const itemIndent = (itemRaw.match(/^(\s*)/)?.[1].length ?? 0);
          if (itemRaw.trim() && itemIndent <= keyIndent) break;
          if (!itemRaw.trim()) { i++; continue; }

          // "  - first_key: val" → starts a new item
          const itemStart = itemRaw.match(/^(\s*)-\s+([a-zA-Z_]\w*):\s*(.*)$/);
          if (itemStart) {
            const item: Record<string, unknown> = {};
            const [, , firstKey, firstVal] = itemStart;
            item[firstKey] = coerceToonScalar(firstVal.trim());
            i++;
            // Gather remaining key-values for this item (same or greater indent)
            const itemResult = parseToonFlatObject(text, i, itemIndent + 1);
            Object.assign(item, itemResult.obj);
            i = itemResult.endLine;
            items.push(item);
          } else {
            i++;
          }
        }
        obj[key] = items;
      } else {
        // Nested object
        const nested = parseToonFlatObject(text, i + 1, nextIndent);
        obj[key] = nested.obj;
        i = nested.endLine;
      }
    }
  }

  return { obj, endLine: i };
}

/** Coerce a raw TOON scalar string to a JS primitive. */
function coerceToonScalar(s: string): unknown {
  if (!s) return s;
  // Strip surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true")  return true;
  if (s === "false") return false;
  if (s === "null")  return null;
  // Keep hex addresses/hashes as strings (starts with 0x and contains non-numeric chars)
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s;
  const n = Number(s);
  if (!Number.isNaN(n) && s.trim() !== "") return n;
  return s;
}

/**
 * Parse the `products[N]:\n  - _id: ...\n    key: val\n  - ...` section
 * from a search-products TOON response.
 */
function parseToonProducts(text: string): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  // Find the products section
  const prodMatch = text.match(/products\[\d+\]:\n([\s\S]*?)(?:\nfound:|$)/);
  if (!prodMatch) return products;

  const body = prodMatch[1];
  // Split on " - _id:" markers (each product starts with "  - _id:")
  const entries = body.split(/\n(?=\s*-\s*_id:)/);
  for (const entry of entries) {
    const p = parseToonProductBlock(entry);
    if (p?._id) products.push(p);
  }
  return products;
}

/**
 * Parse a get-product-details TOON response.
 *
 * Format:
 *   id: airtel-nigeria
 *   name: Airtel Nigeria
 *   currency: NGN
 *   packages[15]{package_value,package_currency,payment_price,payment_currency}:
 *     "50",NGN,"0.05",USD
 *     ...
 *   range:
 *     min: 50
 *     max: 150000
 *   payment_methods:
 *     address_based[24]: ethereum,eth_base,...
 *     link_only[7]: fiat_card,...
 */
function parseToonProductDetails(text: string): Record<string, unknown> | null {
  const lines = text.split("\n");
  const obj: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    // Skip empty lines
    if (!line.trim()) { i++; continue; }

    // Section header with CSV field names: "packages[N]{f1,f2,...}:\n  val,val,..."
    const csvHeader = line.match(/^\s*([a-zA-Z_]\w*)(?:\[\d+\])\{([^}]+)\}:\s*$/);
    if (csvHeader) {
      const key = csvHeader[1];
      const fields = csvHeader[2].split(",").map((f) => f.trim());
      const rows: Record<string, string>[] = [];
      i++;
      while (i < lines.length) {
        const rowLine = lines[i];
        const rowIndent = rowLine.match(/^(\s*)/)?.[1].length ?? 0;
        if (!rowLine.trim() || rowIndent <= indent) break;
        // Parse CSV row — values may be quoted
        const vals = rowLine.trim().match(/("(?:[^"]*)"|[^,]+)/g) ?? [];
        const row: Record<string, string> = {};
        fields.forEach((f, fi) => {
          row[f] = (vals[fi] ?? "").replace(/^"|"$/g, "").trim();
        });
        rows.push(row);
        i++;
      }
      obj[key] = rows;
      continue;
    }

    // Nested section without CSV: "range:\n  min: 50\n  max: 150000"
    const sectionHeader = line.match(/^\s*([a-zA-Z_]\w*)(?:\[\d+\])?\s*:\s*$/);
    if (sectionHeader) {
      const key = sectionHeader[1];
      const nested: Record<string, unknown> = {};
      i++;
      while (i < lines.length) {
        const subLine = lines[i];
        const subIndent = subLine.match(/^(\s*)/)?.[1].length ?? 0;
        if (!subLine.trim() || subIndent <= indent) break;
        // Sub-line: "  key[N]: val1,val2,..."
        const subMatch = subLine.trim().match(/^([a-zA-Z_]\w*)(?:\[\d+\])?:\s*(.+)$/);
        if (subMatch) {
          const subKey = subMatch[1];
          const subVal = subMatch[2].trim();
          // Comma-separated → array
          nested[subKey] = subVal.includes(",")
            ? subVal.split(",").map((v) => v.trim()).filter(Boolean)
            : isNaN(Number(subVal)) ? subVal : Number(subVal);
        }
        i++;
      }
      obj[key] = nested;
      continue;
    }

    // Flat key[N]: val or key: val
    const flat = line.trim().match(/^([a-zA-Z_]\w*)(?:\[\d+\](?:\{[^}]*\})?)?\s*:\s*(.*)$/);
    if (flat) {
      const key = flat[1];
      const val = flat[2].trim().replace(/^"|"$/g, "");
      if (val) {
        // Comma-separated string → array (for categories[N], countries[N], etc.)
        if (line.match(/\[\d+\]:/) && val.includes(",")) {
          obj[key] = val.split(",").map((v) => v.trim()).filter(Boolean);
        } else {
          obj[key] = val === "true" ? true : val === "false" ? false : val;
        }
      }
    }
    i++;
  }

  return Object.keys(obj).length ? obj : null;
}

/**
 * Parse a single product block from TOON (search-products list item). Lines look like:
 *   - _id: mtn-nigeria
 *     name: MTN Nigeria
 *     categories[1]: refill
 *     countries[1]: NG
 *     currency: NGN
 *     in_stock: true
 */
function parseToonProductBlock(text: string): Record<string, unknown> | null {
  const lines = text.split("\n").map((l) => l.replace(/^[\s\-]+/, "").trim()).filter(Boolean);
  if (!lines.length) return null;

  const obj: Record<string, unknown> = {};
  for (const line of lines) {
    // key[N]{...}: value  or  key: value
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\[[^\]]*\])?(?:\{[^}]*\})?:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim().replace(/^"(.*)"$/, "$1"); // strip quotes
    if (val) obj[key] = val;
  }
  return Object.keys(obj).length ? obj : null;
}

function parseToonBlock(block: string): Record<string, unknown> | null {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const obj: Record<string, unknown> = {};

  const header = lines[0].replace(/^\d+\.\s*/, "").replace(/\*\*/g, "");
  const headerMatch = header.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (headerMatch) {
    obj.name = headerMatch[1].trim();
    obj.id   = headerMatch[2].trim();
  } else {
    obj.name = header;
  }

  for (const line of lines.slice(1)) {
    const m = line.match(/^[-•]\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    const val = m[2].trim();
    obj[key] = val;
  }

  return obj;
}

// ── Public types ──────────────────────────────────────────────────────────────

export type PrepaymentField = {
  id: string;
  label: string;
  type: string; // "text" | "select" | "number" | etc.
  required?: boolean;
  max_length?: number | null;
  options?: string[];
};

export type PrepaymentSchema = {
  first_form: PrepaymentField[];
  instructions?: string;
};

export type MCPRatings = {
  rating_value: number;
  rating_count: number;
  review_count?: number;
  score_distribution?: number[];
};

export type MCPReview = {
  content: string;
  score: number;
  score_max?: number;
  author_name: string;
  date: string;
  created_time?: string;
};

export type MCPPaymentMethods = {
  /** Crypto methods that return an on-chain payment address */
  address_based?: string[];
  /** Fiat/third-party methods — redirect to Bitrefill web checkout */
  link_only?: string[];
  /** Account balance / cashback */
  balance?: string[];
};

export type MCPProduct = {
  id: string;
  name: string;
  category: string;
  currency: string;
  countries: string[];
  logo_url?: string;
  /** Fixed packages — only for fixed-denomination products */
  packages?: MCPPackage[];
  /** Range pricing — for custom-amount products */
  range?: { min: number; max: number; step: number; price_rate?: number };
  /** Recipient requirement: "phone_number" | "email" | "account" | "username" | "none" */
  recipient_type?: string;
  /** Human-readable label for the account/ID field, e.g. "Smartcard Number", "Player ID" */
  account_id_name?: string;
  /** Regex pattern the account ID must match, if provided by Bitrefill */
  account_id_regex?: string;
  /** Whether the product is currently available for purchase */
  in_stock?: boolean;
  /** Bill-payment prepayment form (MCP submit-prepayment-step required) */
  prepayment?: PrepaymentSchema;
  /** Short marketing subtitle */
  subtitles?: string;
  /** Full HTML product description */
  descriptions?: string;
  /** HTML redemption instructions */
  instructions?: string;
  /** Plain-text terms and conditions */
  termsConditions?: string;
  /** Star ratings and review summary */
  ratings?: MCPRatings;
  /** Latest customer reviews */
  reviews?: MCPReview[];
  /** Which payment methods this product actually supports */
  payment_methods?: MCPPaymentMethods;
};

export type MCPPackage = {
  /** Full ID: "product_id<&>value" — do NOT use this in buy-products */
  package_id: string;
  /** Denomination value alone: "50" — USE THIS as package_id in buy-products */
  package_value: string;
  price_usd?: number;
};

export type MCPInvoice = {
  invoice_id: string;
  /** Access token required for polling get-invoice-by-id */
  invoice_access_token?: string;
  status: string;
  /** Web checkout link */
  payment_link?: string;
  /** x402-capable wallet endpoint */
  x402_payment_url?: string;
  /**
   * Crypto payment details for direct wallet payment.
   * address       — on-chain deposit address
   * amount        — normalized amount in token units (e.g. 0.08 USDC)
   * altcoinPrice  — raw string price returned by Bitrefill ("0.08")
   * currency      — token symbol (e.g. "USDC")
   * paymentUri    — EIP-681 URI for QR codes
   * contractAddress — ERC-20 token contract address (for EVM tokens)
   */
  payment_info?: {
    address: string;
    amount?: number;
    altcoinPrice?: string | number;
    satoshiPrice?: number;
    altBasePrice?: number;
    currency?: string;
    paymentUri?: string;
    contractAddress?: string;
  };
  expiration_minutes?: number;
  /**
   * ISO-8601 timestamp when Bitrefill created the invoice.
   * Returned by get-invoice-by-id TOON as `created_time`.
   * Used to derive a precise poll deadline: created_time + 15 min.
   */
  created_time?: string;
  orders?: MCPOrder[];
  /** Agent instructions from Bitrefill (next-step guidance) */
  agent_instructions?: string;
  /** eSIM install links returned directly in the invoice */
  esim_install_links?: string[];
};

export type MCPOrder = {
  order_id: string;
  status: string;
  redemption_info?: {
    /** True once the code is ready to read */
    redemption_available?: boolean;
    code?: string;
    link?: string;
    pin?: string;
    instructions?: string;
  };
  esim_install_link?: string;
};

// ── Tool wrappers ─────────────────────────────────────────────────────────────

/**
 * Search the Bitrefill product catalog.
 * MCP tool: search-products
 * Returns TOON or JSON depending on server version.
 */
/** Map category slugs to the `intent` string required by search-products */
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

export async function mcpSearchProducts(opts: {
  query?: string;
  country?: string;
  category?: string;
  limit?: number;
}): Promise<MCPProduct[]> {
  const args: Record<string, unknown> = {
    intent: categoryToIntent(opts.category),
  };
  if (opts.query)   args.query   = opts.query;
  if (opts.country) args.country = opts.country;
  if (opts.limit)   args.limit   = opts.limit;

  const raw = await callTool("search-products", args);
  return normalizeProducts(raw);
}

/**
 * Get full product details including all packages/denominations.
 * MCP tool: get-product-details
 * Required before buy-products to get exact package_value for each denomination.
 */
export async function mcpGetProductDetails(
  productId: string,
  currency = "USD",
): Promise<MCPProduct> {
  const raw = await callTool("get-product-details", { product_id: productId, currency });
  const products = normalizeProducts(raw);
  return products[0] ?? { id: productId, name: productId, category: "", currency, countries: [] };
}

/**
 * Create an invoice for a purchase.
 * MCP tool: buy-products
 *
 * Key rules from docs:
 * - packageId must be package_value (e.g. "50"), NOT the full package_id ("amazon_com-usa<&>50")
 * - Include gift object with recipient_email for code delivery (guest checkout)
 * - Set return_payment_link=false to get crypto payment_info directly
 * - Returns JSON (not TOON) with agent_instructions
 */
export async function mcpBuyProducts(opts: {
  productId: string;
  /** package_value from get-product-details packages[].package_value, e.g. "50" */
  packageId: string;
  /** "usdc_base" | "usdc_solana" | "bitcoin" | "balance" etc. */
  paymentMethod?: string;
  /** Phone number in E.164 for top-ups (required when recipient_type="phone_number") */
  refillInput?: string;
  /**
   * Receipt + code delivery email. Required by the MCP buy-products tool.
   * For gift cards this is also where the code is sent.
   */
  recipientEmail?: string;
  recipientName?: string;
  senderName?: string;
  giftMessage?: string;
  returnPaymentLink?: boolean;
  /** Explicit gift object — takes priority over recipientEmail-based auto-wrapping */
  gift?: {
    recipient_name: string;
    recipient_email: string;
    sender_name: string;
    message?: string;
    theme?: string;
    send_date?: string;
  };
}): Promise<MCPInvoice> {
  // Resolve the receipt/delivery email.
  // buy-products requires a top-level `email` field (for the receipt).
  // Fall back to gift.recipient_email, then a Bluvfi placeholder.
  const receiptEmail =
    opts.recipientEmail ??
    opts.gift?.recipient_email ??
    "receipts@bluvfi.app";

  const cartItem: Record<string, unknown> = {
    product_id:    opts.productId,
    // MCP schema prefers package_value; package_id is deprecated but still accepted
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
      sender_name:     opts.senderName ?? "Bluvfi",
      ...(opts.giftMessage ? { message: opts.giftMessage } : {}),
    };
  }

  const raw = await callTool("buy-products", {
    cart_items:          [cartItem],
    payment_method:      opts.paymentMethod ?? "usdc_base",
    email:               receiptEmail,
    return_payment_link: opts.returnPaymentLink ?? false,
  });

  return normalizeInvoice(raw);
}

/**
 * Poll invoice status. Call every 4 s after payment until status === "complete".
 * MCP tool: get-invoice-by-id
 *
 * Invoice statuses: unpaid → payment_detected → payment_confirmed → pending → complete
 */
export async function mcpGetInvoice(invoiceId: string, accessToken?: string): Promise<MCPInvoice> {
  const args: Record<string, unknown> = { invoice_id: invoiceId };
  if (accessToken) args.invoice_access_token = accessToken;
  const raw = await callTool("get-invoice-by-id", args);
  return normalizeInvoice(raw);
}

// ── Normalisers ───────────────────────────────────────────────────────────────

function normalizeProducts(raw: unknown): MCPProduct[] {
  if (!raw) return [];

  const obj = typeof raw === "string" ? safeParse(raw) : raw;
  // Unwrap data/products wrapper, or use array directly
  const items = Array.isArray(obj)
    ? obj
    : (obj as any)?.data ?? (obj as any)?.products ?? (obj as any)?.results ?? [];

  if (!Array.isArray(items)) return [];

  return (items as any[]).map((p: any) => ({
    // TOON uses _id; JSON uses id/slug
    id:             p._id ?? p.id ?? p.slug ?? p.product_id ?? "",
    name:           p.name ?? p.title ?? p._id ?? p.id ?? "",
    category:       p.category ?? p.type ?? (typeof p.categories === "string" ? p.categories : ""),
    currency:       p.currency ?? p.currencyCode ?? "USD",
    countries:      Array.isArray(p.countries)
                      ? p.countries
                      : typeof p.countries === "string"
                        ? p.countries.split(",").map((c: string) => c.trim()).filter(Boolean)
                        : [],
    // Bitrefill's Cloudinary CDN always returns the same d_operator.png placeholder
    // (identical 460-byte image) for every product slug — there are no real product
    // logos at that path. Only use a logo_url when the API actually provides one.
    logo_url:        p.logo_url ?? p.logoImage ?? p.image ?? undefined,
    packages:        Array.isArray(p.packages) ? p.packages.map(normPkg) : undefined,
    range:           normRange(p.range),
    recipient_type:  p.recipient_type ?? undefined,
    account_id_name: p.account_id_name ?? undefined,
    account_id_regex:p.account_id_regex ?? undefined,
    in_stock:        p.in_stock ?? true,
    prepayment:      p.prepayment ?? undefined,
    subtitles:       p.subtitles ?? undefined,
    descriptions:    p.descriptions ?? p.url /* TOON uses "url" for product page */ ? undefined : undefined,
    instructions:    p.instructions ?? undefined,
    termsConditions: p.termsConditions ?? p.terms_conditions ?? undefined,
    ratings:         normRatings(p.ratings),
    reviews:         normReviews(p.reviews),
    payment_methods: normPaymentMethods(p.payment_methods),
  }));
}

function normPkg(p: any): MCPPackage {
  // TOON CSV rows: { package_value, package_currency, payment_price, payment_currency }
  const packageValue = String(p.package_value ?? p.value ?? p.denomination ?? "");
  const paymentPrice = parseFloat(p.payment_price ?? p.price_usd ?? p.price ?? "0") || undefined;
  return {
    package_id:    p.package_id ?? p.id ?? packageValue,
    package_value: packageValue,
    // payment_price is in payment_currency (USD for most) — use as price_usd
    price_usd:     p.price_usd ?? p.priceInUsd ?? paymentPrice,
  };
}

function normRange(r: any): MCPProduct["range"] | undefined {
  if (!r) return undefined;
  const min = Number(r.min ?? r.min_value ?? 0);
  const max = Number(r.max ?? r.max_value ?? 0);
  if (!min && !max) return undefined;
  return { min, max, step: Number(r.step ?? r.value_step ?? 1), price_rate: r.price_rate ? Number(r.price_rate) : undefined };
}

function normRatings(r: any): MCPProduct["ratings"] | undefined {
  if (!r || typeof r !== "object") return undefined;
  return {
    rating_value:       Number(r.rating_value ?? 0),
    rating_count:       Number(r.rating_count ?? 0),
    review_count:       r.review_count != null ? Number(r.review_count) : undefined,
    score_distribution: Array.isArray(r.score_distribution)
      ? r.score_distribution.map(Number)
      : typeof r.score_distribution === "string"
        ? r.score_distribution.split(",").map(Number)
        : undefined,
  };
}

function normReviews(r: any): MCPProduct["reviews"] | undefined {
  if (!Array.isArray(r)) return undefined;
  return r.map((rv: any) => ({
    content:     rv.content ?? "",
    score:       Number(rv.score ?? 0),
    score_max:   rv.score_max != null ? Number(rv.score_max) : undefined,
    author_name: rv.author_name ?? "",
    date:        rv.date ?? rv.created_time ?? "",
  }));
}

function normPaymentMethods(pm: any): MCPProduct["payment_methods"] | undefined {
  if (!pm || typeof pm !== "object") return undefined;
  const toArr = (v: unknown): string[] =>
    Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return {
    address_based: pm.address_based ? toArr(pm.address_based) : undefined,
    link_only:     pm.link_only     ? toArr(pm.link_only)     : undefined,
    balance:       pm.balance       ? toArr(pm.balance)       : undefined,
  };
}

/**
 * buy-products response shape (CLI / MCP):
 *   { response: { invoice_id, invoice_access_token, payment_info: { address, altcoinPrice, … }, … },
 *     agent_instructions: "…" }
 *
 * get-invoice-by-id response shape (flat — no wrapper):
 *   { invoice_id, invoice_status, orders_delivery_status, payment_info: { … }, orders: […], … }
 *
 * The key difference:
 *   • buy-products wraps everything in `response`; status field is absent (invoice is new/unpaid)
 *   • get-invoice-by-id is flat; uses `invoice_status` (not `status`) for the lifecycle state
 *
 * Lifecycle values for `invoice_status`:
 *   unpaid → payment_detected → payment_confirmed → pending → complete
 *   failed | expired | cancelled | refunded  (terminal errors)
 */
function normalizeInvoice(raw: unknown): MCPInvoice {
  const obj: any = typeof raw === "string" ? safeParse(raw) : raw;
  if (!obj) throw new Error("Empty invoice response from Bitrefill");

  // Unwrap if buy-products wrapper present; get-invoice-by-id is flat
  const inv = obj.response ?? obj.invoice ?? obj.data ?? obj;

  // `invoice_status` is the authoritative field from get-invoice-by-id.
  // buy-products doesn't include a status field (invoice is freshly created/unpaid).
  const status = inv.invoice_status ?? inv.status ?? "unpaid";

  // payment_link can come from buy-products or as checkout_url from get-invoice-by-id
  const payment_link = inv.payment_link ?? inv.checkout_url ?? undefined;

  // invoice_access_token: check both the inner `inv` and the outer wrapper `obj`,
  // as buy-products may place it at either level depending on the response version.
  const invoice_access_token =
    inv.invoice_access_token ?? (obj as any).invoice_access_token ?? undefined;

  return {
    invoice_id:              inv.invoice_id ?? inv.id ?? "",
    invoice_access_token,
    status,
    payment_link,
    x402_payment_url:        inv.x402_payment_url ?? undefined,
    payment_info:            normalizePaymentInfo(inv),
    expiration_minutes:      inv.expiration_minutes ?? inv.expiresInMinutes ?? undefined,
    // created_time is returned by get-invoice-by-id TOON. Used by the client to
    // derive a precise poll deadline (created_time + 15 min) when expiration_minutes
    // is absent — Bitrefill's MCP does not expose an explicit expiry field.
    created_time:            inv.created_time ?? inv.createdTime ?? undefined,
    orders:                  Array.isArray(inv.orders) ? inv.orders.map(normOrder) : undefined,
    // agent_instructions may sit at the outer wrapper level (CLI / MCP buy-products pattern)
    agent_instructions:      obj.agent_instructions ?? inv.agent_instructions ?? undefined,
    esim_install_links:      inv.esim_install_links ?? undefined,
    // Pass through delivery status — used as a secondary completion signal in the UI
    ...(inv.orders_delivery_status ? { orders_delivery_status: inv.orders_delivery_status } : {}),
  } as MCPInvoice & { orders_delivery_status?: string };
}

function normalizePaymentInfo(inv: any): MCPInvoice["payment_info"] | undefined {
  const pi = inv.payment_info;
  if (pi?.address) {
    return {
      address:         pi.address,
      // altcoinPrice is the token amount as a string (e.g. "0.08" USDC)
      amount:          pi.amount ?? (pi.altcoinPrice != null ? Number(pi.altcoinPrice) : undefined),
      altcoinPrice:    pi.altcoinPrice,
      satoshiPrice:    pi.satoshiPrice,
      altBasePrice:    pi.altBasePrice,
      currency:        pi.currency,
      paymentUri:      pi.paymentUri,
      contractAddress: pi.contractAddress,
    };
  }
  // Legacy REST compat shim
  if (inv.payment?.address) {
    return {
      address:  inv.payment.address,
      amount:   Number(inv.payment.price ?? inv.payment.amount ?? 0) || undefined,
      currency: inv.payment.currency ?? "USDC",
    };
  }
  return undefined;
}

function normOrder(o: any): MCPOrder {
  // get-invoice-by-id puts redemption_available + code at the order level;
  // the nested redemption_info shape may also appear (MCP buy-products style).
  const redemptionInfo = o.redemption_info ?? (
    (o.redemption_available || o.code || o.pin || o.link)
      ? {
          redemption_available: o.redemption_available ?? false,
          code: o.code ?? undefined,
          pin:  o.pin  ?? undefined,
          link: o.link ?? o.access_link ?? undefined,
          instructions: o.redemption_instructions ?? undefined,
        }
      : undefined
  );

  return {
    order_id:          o.order_id ?? o.id ?? "",
    status:            o.status ?? "",
    redemption_info:   redemptionInfo,
    esim_install_link: o.esim_install_link ?? undefined,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Submit one prepayment form step.
 * MCP tool: submit-prepayment-step
 *
 * Call with increasing step_number until response.step === "final".
 * The final response includes bill_payment_id — pass it to mcpBuyProducts.
 *
 * This tool is MCP-only; the CLI has no equivalent command.
 */
export async function mcpSubmitPrepaymentStep(opts: {
  product_id: string;
  step_number: number;
  form_data: Record<string, string>;
}): Promise<{ step: string; bill_payment_id?: string; next_form?: import("./bitrefill-mcp").PrepaymentField[] }> {
  if (!isMCPConfigured()) {
    throw new Error("Prepayment form submission requires MCP (BITREFILL_MCP_URL or BITREFILL_API_KEY).");
  }
  const raw = await callTool("submit-prepayment-step", {
    product_id: opts.product_id,
    step_number: opts.step_number,
    form_data:   opts.form_data,
  });
  return raw as any;
}

// ── Code extraction ───────────────────────────────────────────────────────────

/**
 * Extract the redemption code from a completed invoice.
 * Per docs: orders[].redemption_info.code (when redemption_available=true)
 * For eSIMs: orders[].esim_install_link or invoice.esim_install_links[0]
 */
export function extractMCPCode(invoice: MCPInvoice): string | null {
  // Check nested orders first
  for (const order of invoice.orders ?? []) {
    const r = order.redemption_info;
    if (r?.redemption_available !== false) {
      const code = r?.code ?? r?.pin ?? r?.link;
      if (code) return code;
    }
    if (order.esim_install_link) return order.esim_install_link;
  }
  // Top-level eSIM install links (returned directly in buy-products response)
  if (invoice.esim_install_links?.[0]) return invoice.esim_install_links[0];
  return null;
}
