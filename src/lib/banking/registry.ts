import type { BankingProvider } from "./types";
import { credibleProvider } from "./providers/credible";
import { rippleOdlProvider } from "./providers/ripple-odl";

/**
 * All registered banking providers.
 * To add a new provider: implement BankingProvider, import it here, push it to the array.
 */
const ALL_PROVIDERS: BankingProvider[] = [
  credibleProvider,
  rippleOdlProvider,
];

/** Returns all providers that have their env vars configured. */
export function getConfiguredProviders(): BankingProvider[] {
  return ALL_PROVIDERS.filter((p) => p.isConfigured());
}

/** Looks up a provider by slug (e.g. "credible"). Throws 404-style error if not found. */
export function getProvider(id: string): BankingProvider {
  const provider = ALL_PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown banking provider: "${id}"`);
  return provider;
}

/** Returns provider metadata safe to send to the client (no secrets). */
export function getProviderMeta(p: BankingProvider) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    currency: p.currency,
    currencySymbol: p.currencySymbol,
    flag: p.flag,
    minCollectionAmount: p.minCollectionAmount,
    configured: p.isConfigured(),
  };
}

export type ProviderMeta = ReturnType<typeof getProviderMeta>;
