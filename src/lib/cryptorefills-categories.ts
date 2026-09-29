/**
 * How Cryptorefills brands are grouped in Bluvfi. Shared by the Bills screen
 * and the AI tools so both filter the catalogue the same way. Pure — safe to
 * import from client and server code.
 */

/** Top-level sections: gift cards, phone refills, eSIMs. */
export type CrKind = "cards" | "topup" | "esim";

/** Gift-card sub-filters, same set as the Bitrefill browser. */
export type CrCardCategory = "entertainment" | "gaming" | "shopping" | "food" | "vpn" | "travel";

export function kindOf(category: string): CrKind | null {
  if (category === "e-sim") return "esim";
  if (category.startsWith("mobile_")) return "topup";
  if (category === "e-money") return null; // needs a Cryptorefills whitelabel account
  return "cards";
}

// Cryptorefills has no privacy category — VPNs and password managers are filed under "electronics".
const PRIVACY_RE = /vpn|nordpass|proton|surfshark|mullvad|cyberghost|ivacy|1password|bitwarden|dashlane|keeper|incogni/i;

export function cardCategoryOf(brand: { brand_name: string; category: string }): CrCardCategory | null {
  if (PRIVACY_RE.test(brand.brand_name)) return "vpn";
  switch (brand.category) {
    case "entertainment": case "streaming": return "entertainment";
    case "games": return "gaming";
    case "food": case "groceries": return "food";
    case "travel_flights": return "travel";
    case "e-commerce": case "retail": case "apparel_clothing": case "electronics":
    case "home": case "health_beauty": case "sports_fitness": return "shopping";
    default: return null; // e.g. charity — only under "All"
  }
}

/** The catalogue repeats some brands (e.g. NordPass ×3); keep the first of each name. */
export function dedupeBrands<T extends { brand_name: string }>(brands: T[]): T[] {
  const seen = new Set<string>();
  return brands.filter((b) => (seen.has(b.brand_name) ? false : (seen.add(b.brand_name), true)));
}
