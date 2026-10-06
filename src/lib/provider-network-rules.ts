import { isSolanaAddress } from "@/lib/shar-rules";

/**
 * Rules for the open provider network: anyone can list a provider or protocol, the team verifies it, and once people use it
 * the owner earns Shar (and, later, x402 commission). No database access here.
 *
 * Listings are user-supplied URLs that the server may call on someone else's behalf, so the URL checks are strict:
 * https only, a real public hostname, no credentials in the URL, and (at call time) every address it resolves to must be public.
 */

export const NETWORK = {
  categories: ["data", "ai", "payments", "defi", "identity", "other"] as const,
  maxListingsPerUser: 10,
  maxSubmissionsPerDay: 5,
  nameMin: 3,
  nameMax: 40,
  summaryMin: 10,
  summaryMax: 280,
  /** Highest price per call a listing may ask (USDC). Paid calls settle over x402, which isn't switched on yet. */
  maxPriceUsdc: 5,
  /** Shar-earning uses per caller per listing per day; further uses still work but earn the owner nothing. */
  earningUsesPerCallerPerDay: 5,
  /** Most Shar one owner can earn from provider use in a day, across all their listings. */
  ownerDailyShar: 100,
  maxRequestBytes: 8_192,
  maxResponseBytes: 262_144,
  callTimeoutMs: 10_000,
} as const;

export type Category = (typeof NETWORK.categories)[number];

const PRIVATE_TLDS = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".private", ".test", ".invalid"];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A parsed https URL that points at a real public hostname, or null. */
export function safePublicUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "443") return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".")) return null;
  if (host.startsWith("[") || host.includes(":") || IPV4.test(host)) return null; // no IP literals at all
  if (PRIVATE_TLDS.some((t) => host.endsWith(t))) return null;
  // The URL parser turns look-alike unicode hosts into xn-- punycode: refuse those so a listing can't pose as another site.
  if (!/^[a-z0-9.-]+$/.test(host) || host.split(".").some((label) => label.startsWith("xn--"))) return null;
  return u;
}

/** Whether a resolved IP address is a normal public one (not loopback, private, link-local, CGNAT, multicast…). */
export function isPublicIp(ip: string): boolean {
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local, including cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  const v6 = ip.toLowerCase();
  if (!v6.includes(":")) return false;
  if (v6 === "::" || v6 === "::1") return false;
  if (/^f[cd]/.test(v6)) return false; // unique local
  if (/^fe[89ab]/.test(v6)) return false; // link-local
  if (v6.startsWith("ff")) return false; // multicast
  if (v6.startsWith("64:ff9b")) return false; // NAT64 can reach private v4
  return true;
}

export function slugify(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "provider";
  const tail = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => (b % 36).toString(36)).join("");
  return `${base}-${tail}`;
}

export interface ListingInput {
  name: string;
  summary: string;
  category: Category;
  endpointUrl: string;
  docsUrl: string | null;
  priceUsdc: string;
  payoutWallet: string;
  remixOfId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateListingInput(input: unknown): { ok: true; value: ListingInput } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "Send the listing as an object." };
  const b = input as Record<string, unknown>;

  const text = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
  const name = text(b.name);
  if (name.length < NETWORK.nameMin || name.length > NETWORK.nameMax || CONTROL.test(name)) {
    return { ok: false, error: `Name must be ${NETWORK.nameMin}–${NETWORK.nameMax} characters.` };
  }
  const summary = text(b.summary);
  if (summary.length < NETWORK.summaryMin || summary.length > NETWORK.summaryMax || CONTROL.test(summary)) {
    return { ok: false, error: `Description must be ${NETWORK.summaryMin}–${NETWORK.summaryMax} characters.` };
  }
  if (!NETWORK.categories.includes(b.category as Category)) return { ok: false, error: "Pick a category." };

  const endpoint = safePublicUrl(b.endpointUrl);
  if (!endpoint) return { ok: false, error: "The endpoint must be a public https:// address (no IP addresses or local hosts)." };

  let docsUrl: string | null = null;
  if (b.docsUrl !== undefined && b.docsUrl !== null && b.docsUrl !== "") {
    const docs = safePublicUrl(b.docsUrl);
    if (!docs) return { ok: false, error: "The docs link must be a public https:// address." };
    docsUrl = docs.toString();
  }

  const rawPrice = b.priceUsdc === undefined || b.priceUsdc === null || b.priceUsdc === "" ? "0" : String(b.priceUsdc).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(rawPrice) || Number(rawPrice) > NETWORK.maxPriceUsdc) {
    return { ok: false, error: `Price per call must be between 0 and ${NETWORK.maxPriceUsdc} USDC.` };
  }
  if (!isSolanaAddress(b.payoutWallet)) return { ok: false, error: "Enter the Solana wallet address where you want to be paid." };

  let remixOfId: string | null = null;
  if (b.remixOfId !== undefined && b.remixOfId !== null && b.remixOfId !== "") {
    if (typeof b.remixOfId !== "string" || !UUID.test(b.remixOfId)) return { ok: false, error: "That provider to remix wasn't found." };
    remixOfId = b.remixOfId.toLowerCase();
  }

  return {
    ok: true,
    value: {
      name,
      summary,
      category: b.category as Category,
      endpointUrl: endpoint.toString(),
      docsUrl,
      priceUsdc: String(Number(rawPrice)),
      payoutWallet: b.payoutWallet,
      remixOfId,
    },
  };
}
