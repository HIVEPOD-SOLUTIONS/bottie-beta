import { defineChain, parseAbi, type Chain, type Hex } from "viem";
import { base } from "viem/chains";

/**
 * Doma mainnet (chain 97477) — where Doma domain registrations/renewals are
 * paid (USDC.e or ETH) and where DOMA-orderbook listings settle. Client-safe:
 * used by the Privy config (so the wallet can switch to it) and by the chat's
 * Doma pay cards.
 */
export const domaChain = defineChain({
  id: 97477,
  name: "Doma",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.doma.xyz"] } },
  blockExplorers: { default: { name: "Doma Explorer", url: "https://explorer.doma.xyz" } },
});

export const DOMA_BRIDGE_URL = "https://bridge.doma.xyz";

// ── Marketplace (Seaport) ────────────────────────────────────────────────────
//
// Doma listings are Seaport 1.6 orders. Verified on-chain: Seaport's
// getOrderHash() over a listing's parameters equals the listing's
// externalId, and information() reports version 1.6.

export const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395" as const;

/**
 * Chains whose listings Bluvfi can fill: Doma (the DOMA orderbook) and Base
 * (Seaport 1.6 sits at the same canonical address there, and the wallet
 * already supports it). Listings on other chains are refused by the tool.
 */
export const LISTING_CHAINS: Record<number, Chain> = { [domaChain.id]: domaChain, [base.id]: base };
export const SUPPORTED_LISTING_CHAINS = Object.keys(LISTING_CHAINS).map(Number);
export const SEAPORT_CONDUIT_CONTROLLER = "0x00000000F9490004C11Cef243f5400493c00Ad63" as const;
export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;

export const SEAPORT_ABI = parseAbi([
  "struct OfferItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; }",
  "struct ConsiderationItem { uint8 itemType; address token; uint256 identifierOrCriteria; uint256 startAmount; uint256 endAmount; address recipient; }",
  "struct OrderParameters { address offerer; address zone; OfferItem[] offer; ConsiderationItem[] consideration; uint8 orderType; uint256 startTime; uint256 endTime; bytes32 zoneHash; uint256 salt; bytes32 conduitKey; uint256 totalOriginalConsiderationItems; }",
  "struct AdvancedOrder { OrderParameters parameters; uint120 numerator; uint120 denominator; bytes signature; bytes extraData; }",
  "struct CriteriaResolver { uint256 orderIndex; uint8 side; uint256 index; uint256 identifier; bytes32[] criteriaProof; }",
  "function fulfillAdvancedOrder(AdvancedOrder advancedOrder, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) payable returns (bool fulfilled)",
]);

export const CONDUIT_CONTROLLER_ABI = parseAbi([
  "function getConduit(bytes32 conduitKey) view returns (address conduit, bool exists)",
]);

/** The fulfillment payload Doma's `/v1/orderbook/listing/{orderId}/{buyer}` returns. */
export interface DomaListingFulfillment {
  order: {
    signature: Hex;
    parameters: {
      offerer: Hex;
      zone: Hex;
      offer: { itemType: number; token: Hex; identifierOrCriteria: string; startAmount: string; endAmount: string }[];
      consideration: { itemType: number; token: Hex; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: Hex }[];
      orderType: number;
      startTime: string;
      endTime: string;
      zoneHash: Hex;
      salt: string;
      conduitKey: Hex;
      counter?: string;
      totalOriginalConsiderationItems: number | string;
    };
  };
  extraData?: Hex;
}

/** Seaport item types the buyer pays with. */
const NATIVE = 0;
const ERC20 = 1;

/**
 * What the buyer must pay, per token: the sum of consideration items the
 * buyer supplies (native ETH / ERC-20). Throws for listings priced in NFTs,
 * which a buyer can't settle from a wallet balance.
 */
export function listingPayment(f: DomaListingFulfillment): { token: Hex | "native"; amount: bigint } {
  const items = f.order.parameters.consideration;
  if (items.some((c) => c.itemType !== NATIVE && c.itemType !== ERC20)) throw new Error("This listing isn't priced in a token.");
  const tokens = new Set(items.map((c) => (c.itemType === NATIVE ? "native" : c.token.toLowerCase())));
  if (tokens.size !== 1) throw new Error("This listing is priced in more than one token.");
  const amount = items.reduce((s, c) => s + BigInt(c.endAmount), BigInt(0));
  const first = items[0];
  return { token: first.itemType === NATIVE ? "native" : first.token, amount };
}

/** Seaport AdvancedOrder (full fill) built from Doma's fulfillment payload. */
export function toAdvancedOrder(f: DomaListingFulfillment) {
  const p = f.order.parameters;
  return {
    parameters: {
      offerer: p.offerer,
      zone: p.zone,
      offer: p.offer.map((o) => ({ itemType: o.itemType, token: o.token, identifierOrCriteria: BigInt(o.identifierOrCriteria), startAmount: BigInt(o.startAmount), endAmount: BigInt(o.endAmount) })),
      consideration: p.consideration.map((c) => ({ itemType: c.itemType, token: c.token, identifierOrCriteria: BigInt(c.identifierOrCriteria), startAmount: BigInt(c.startAmount), endAmount: BigInt(c.endAmount), recipient: c.recipient })),
      orderType: p.orderType,
      startTime: BigInt(p.startTime),
      endTime: BigInt(p.endTime),
      zoneHash: p.zoneHash,
      salt: BigInt(p.salt),
      conduitKey: p.conduitKey,
      totalOriginalConsiderationItems: BigInt(p.totalOriginalConsiderationItems),
    },
    numerator: BigInt(1),
    denominator: BigInt(1),
    signature: f.order.signature,
    extraData: (f.extraData ?? "0x") as Hex,
  };
}
