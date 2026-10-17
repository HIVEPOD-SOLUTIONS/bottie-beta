/**
 * Chains where Privy user-pays gas sponsorship (gas in the wallet's USDC) works.
 * Not Arc (Privy: "Asset usdc is not configured for gas payments on chain eip155:5042" —
 * Arc's native gas is already USDC), and not Tempo (it rejects `sponsor_options`).
 */
export const PRIVY_SPONSORED_CHAIN_IDS = new Set([1, 8453, 137, 42161, 10]);
