/**
 * x402 / MPP universal consumer — multi-EVM + Solana, USDC + USDT.
 *
 * Enforces:
 *  - Exact CAIP-2 network match against an allowlist
 *  - A per-call price cap (default $0.002 USDC)
 *  - Sign-once semantics (a single credential is built then committed)
 *  - Retry-once on transient 402 / network errors
 *
 * Returns a typed receipt so the AI planner can log, display, and reason about
 * what was paid and what was returned.
 *
 * Supported CAIP-2 networks & tokens
 *  EVM (USDC + USDT)
 *  • "eip155:8453"   — Base mainnet       (Circle Gateway, gasless for agent)
 *  • "eip155:42161"  — Arbitrum One       (viem + ERC-20 transfer)
 *  • "eip155:10"     — Optimism           (viem + ERC-20 transfer)
 *  • "eip155:137"    — Polygon            (viem + ERC-20 transfer)
 *  • "eip155:43114"  — Avalanche C-Chain  (viem + ERC-20 transfer)
 *  • "eip155:1"      — Ethereum mainnet   (viem + ERC-20 transfer, slow/expensive)
 *
 *  Solana (USDC + USDT + PYUSD + USDG + CASH)
 *  • "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" — Solana mainnet (pay-kit)
 *
 * Agent wallet requirements
 *  - Base:     Circle Gateway sponsors gas — only USDC/USDT balance needed.
 *  - Other EVM: agent wallet needs native token (ETH / MATIC / AVAX) for gas
 *               + the stablecoin to transfer.  Make sure the wallet is funded
 *               on every chain before enabling non-Base EVM offers.
 *  - Solana:   pay-kit sponsor key pays SOL rent; agent key signs.
 *
 * Environment variables required:
 *  CIRCLE_BUYER_PRIVATE_KEY     — EVM agent signing key (hex, with or without 0x)
 *  SOLANA_AGENT_PRIVATE_KEY     — Solana agent signing key (base58 64-byte)
 */

// ── CAIP-2 network constants ──────────────────────────────────────────────────

export const CAIP2_BASE_MAINNET      = "eip155:8453";
export const CAIP2_ARBITRUM_MAINNET  = "eip155:42161";
export const CAIP2_OPTIMISM_MAINNET  = "eip155:10";
export const CAIP2_POLYGON_MAINNET   = "eip155:137";
export const CAIP2_AVALANCHE_MAINNET = "eip155:43114";
export const CAIP2_ETHEREUM_MAINNET  = "eip155:1";
export const CAIP2_SOLANA_MAINNET    =
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** Networks Bluvfi is allowed to pay on (mainnet only). */
export const ALLOWED_NETWORKS = new Set([
  CAIP2_BASE_MAINNET,
  CAIP2_ARBITRUM_MAINNET,
  CAIP2_OPTIMISM_MAINNET,
  CAIP2_POLYGON_MAINNET,
  CAIP2_AVALANCHE_MAINNET,
  CAIP2_ETHEREUM_MAINNET,
  CAIP2_SOLANA_MAINNET,
]);

export const DEFAULT_MAX_PRICE_USD = 0.002; // $0.002 cap
export const USDC_DECIMALS = 6;

// ── EVM chain registry ────────────────────────────────────────────────────────

interface ChainConfig {
  chainId: number;
  name: string;
  /** Alchemy RPC (API key injected at runtime) */
  rpc: () => string;
  /** USDC contract address (checksummed) */
  usdc: string;
  /** USDT contract address (checksummed) */
  usdt: string;
  /** Native currency symbol — needed for viem chain definition */
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

const ALCHEMY_KEY = () => process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? "";

const CHAIN_CONFIG: Record<string, ChainConfig> = {
  [CAIP2_BASE_MAINNET]: {
    chainId: 8453,
    name: "Base",
    rpc: () => `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY()}`,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdt: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  [CAIP2_ARBITRUM_MAINNET]: {
    chainId: 42161,
    name: "Arbitrum One",
    rpc: () => `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY()}`,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  [CAIP2_OPTIMISM_MAINNET]: {
    chainId: 10,
    name: "Optimism",
    rpc: () => `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY()}`,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    usdt: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  [CAIP2_POLYGON_MAINNET]: {
    chainId: 137,
    name: "Polygon",
    rpc: () => `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY()}`,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    usdt: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  },
  [CAIP2_AVALANCHE_MAINNET]: {
    chainId: 43114,
    name: "Avalanche C-Chain",
    rpc: () => `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY()}`,
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    usdt: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  },
  [CAIP2_ETHEREUM_MAINNET]: {
    chainId: 1,
    name: "Ethereum",
    rpc: () => `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY()}`,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
};

/** Known Solana stablecoin mints */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// ── Offer scoring ─────────────────────────────────────────────────────────────

/**
 * Score a payment offer for settlement preference.
 * Higher score = more preferred.
 *
 * Priorities:
 *  1. Base (Circle Gateway — no gas required for agent)
 *  2. Solana (near-zero fees, fast finality)
 *  3. Arbitrum / Optimism (low gas L2s)
 *  4. Polygon / Avalanche (mid-tier)
 *  5. Ethereum (expensive, slow — last resort)
 * Within each chain: USDC > USDT.
 */
function offerScore(o: PaymentOffer): number {
  const chain = CHAIN_CONFIG[o.network];
  const isUsdc = chain
    ? o.asset.toLowerCase() === chain.usdc.toLowerCase()
    : o.asset === SOLANA_USDC_MINT;

  switch (o.network) {
    case CAIP2_BASE_MAINNET:      return isUsdc ? 100 :  90;
    case CAIP2_SOLANA_MAINNET:    return isUsdc ?  80 :  70;
    case CAIP2_ARBITRUM_MAINNET:  return isUsdc ?  65 :  55;
    case CAIP2_OPTIMISM_MAINNET:  return isUsdc ?  60 :  50;
    case CAIP2_POLYGON_MAINNET:   return isUsdc ?  45 :  35;
    case CAIP2_AVALANCHE_MAINNET: return isUsdc ?  40 :  30;
    case CAIP2_ETHEREUM_MAINNET:  return isUsdc ?  20 :  10;
    default: return 0;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConsumeOffer {
  /** Fully-qualified URL to fetch */
  url: string;
  /** HTTP method for the protected resource (default GET) */
  method?: "GET" | "POST";
  /** Request body for POST resources */
  body?: Record<string, unknown>;
  /**
   * Maximum price in USD Bluvfi will pay for this call (default $0.002).
   * If every offer exceeds this, the call is rejected before any signing.
   */
  maxPriceUsd?: number;
  /**
   * Allowlist of CAIP-2 networks Bluvfi will accept for this call.
   * Defaults to ALLOWED_NETWORKS. Pass a subset to restrict further.
   */
  allowedNetworks?: Set<string>;
}

export interface PaymentOffer {
  /** Raw offer from the 402 response */
  scheme: string;
  network: string;
  asset: string;
  /** Amount in smallest unit (e.g. 1_000_000 = 1 USDC at 6 decimals) */
  amount: string;
  payTo: string;
  extra?: Record<string, unknown>;
}

export interface ConsumeReceipt {
  /** Which CAIP-2 network was used */
  network: string;
  /** Amount paid in USD (human-readable) */
  amountUSDC: number;
  /** Asset address / mint paid */
  asset: string;
  /** Payer address (agent wallet) */
  payer: string;
  /** Settlement / transaction reference (tx hash, batch ID, or MPP ref) */
  reference: string;
  /** Whether a retry was needed */
  retried: boolean;
}

export interface ConsumeResult {
  receipt: ConsumeReceipt;
  /** Parsed JSON response from the protected resource */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  /** HTTP status of the final successful response */
  status: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseOffers(paymentRequiredHeader: string): PaymentOffer[] {
  try {
    const decoded = Buffer.from(paymentRequiredHeader, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    // x402-batching shape: { accepts: [...] }
    const accepts: unknown[] = Array.isArray(parsed.accepts)
      ? parsed.accepts
      : Array.isArray(parsed)
        ? parsed
        : [];
    return accepts as PaymentOffer[];
  } catch {
    return [];
  }
}

function amountToUSD(amount: string, decimals = USDC_DECIMALS): number {
  return Number(amount) / Math.pow(10, decimals);
}

function isEVM(network: string) {
  return network.startsWith("eip155:");
}

function isSolana(network: string) {
  return network.startsWith("solana:");
}

/** Returns true if the offer's asset is a known USDC or USDT token on its network. */
function isKnownToken(offer: PaymentOffer): boolean {
  if (isEVM(offer.network)) {
    const chain = CHAIN_CONFIG[offer.network];
    if (!chain) return false;
    const addr = offer.asset.toLowerCase();
    return addr === chain.usdc.toLowerCase() || addr === chain.usdt.toLowerCase();
  }
  if (isSolana(offer.network)) {
    return offer.asset === SOLANA_USDC_MINT || offer.asset === SOLANA_USDT_MINT;
  }
  return false;
}

/**
 * Pick the best offer: highest score among those within the price cap and
 * on an allowed network. Only known USDC/USDT assets are eligible.
 */
function selectOffer(
  offers: PaymentOffer[],
  maxPriceUsd: number,
  allowed: Set<string>,
): PaymentOffer | null {
  const eligible = offers.filter((o) => {
    if (!allowed.has(o.network)) return false;
    if (!isKnownToken(o)) return false;
    return amountToUSD(o.amount) <= maxPriceUsd;
  });

  if (eligible.length === 0) return null;
  return eligible.reduce((best, o) => offerScore(o) > offerScore(best) ? o : best, eligible[0]);
}

// ── EVM payment: Base via Circle Gateway ─────────────────────────────────────

async function payEVMBase(
  offer: PaymentOffer,
  maxPriceUsd: number,
  url: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<ConsumeResult> {
  const { getBuyerClient } = await import("@/lib/circle-gateway");
  const client = getBuyerClient();

  // Second-layer cap: re-enforce spend mandate at signing time.
  // selectOffer already filtered by price at probe time, but GatewayClient.fetch
  // re-negotiates requirements internally — onBeforePaymentCreation catches any drift.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (client as any).onBeforePaymentCreation === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).onBeforePaymentCreation(async (ctx: any) => {
      const signingAmount =
        Number(
          ctx?.selectedRequirements?.amount ?? ctx?.requirements?.amount ?? 0,
        ) / 1_000_000;
      if (signingAmount > maxPriceUsd) {
        return {
          abort: true,
          reason: `Spend mandate exceeded at signing: server requests $${signingAmount} USDC but cap is $${maxPriceUsd}`,
        };
      }
    });
  }

  const init: RequestInit =
    method === "POST"
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }
      : { method: "GET" };

  // GatewayClient.fetch handles the 402 → sign → settlement cycle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: Response = await (client as any).fetch(url, init);

  // Parse Circle's settlement receipt from the PAYMENT-RESPONSE header
  const paymentResponse = res.headers.get("payment-response") ?? "";
  let reference = "evm-base-paid";
  try {
    const pr = JSON.parse(Buffer.from(paymentResponse, "base64").toString("utf8"));
    reference = pr?.transaction ?? pr?.batchId ?? pr?.reference ?? "evm-base-paid";
  } catch {
    // header absent or malformed — fallback already set
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any = null;
  try { result = await res.json(); }
  catch { result = await res.text().catch(() => null); }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payer: string = (client as any).address ?? "unknown";

  return {
    receipt: {
      network: offer.network,
      amountUSDC: amountToUSD(offer.amount),
      asset: offer.asset,
      payer,
      reference,
      retried: false, // overwritten by consume402 spread at call-site
    },
    result,
    status: res.status,
  };
}

// ── EVM payment: non-Base chains via viem + ERC-20 transfer ──────────────────

/**
 * Generic EVM payer for Arbitrum, Optimism, Polygon, Avalanche, Ethereum.
 *
 * Flow:
 *   1. Build a viem WalletClient from CIRCLE_BUYER_PRIVATE_KEY
 *   2. Execute ERC-20 transfer to offer.payTo for offer.amount
 *   3. Wait for on-chain confirmation
 *   4. Build a standard x402 payment credential containing the tx hash
 *   5. Retry the resource URL with X-Payment + PAYMENT-SIGNATURE headers
 *
 * The x402 credential format used here follows the open x402 spec:
 *   base64(JSON { x402Version, scheme, network, payload: { txHash, payer, asset, amount } })
 *
 * Note: the agent wallet must hold native gas tokens (ETH/POL/AVAX) on each
 * chain you enable, in addition to the stablecoin being transferred.
 */
async function payEVMGeneric(
  offer: PaymentOffer,
  url: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<ConsumeResult> {
  const { createWalletClient, createPublicClient, http, parseAbi } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");

  const rawKey = process.env.CIRCLE_BUYER_PRIVATE_KEY ?? "";
  if (!rawKey) throw new Error("CIRCLE_BUYER_PRIVATE_KEY not set — cannot pay on " + offer.network);
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;

  const chain = CHAIN_CONFIG[offer.network];
  if (!chain) throw new Error(`No chain config for network ${offer.network}`);

  const account = privateKeyToAccount(privateKey);

  const viemChain = {
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [chain.rpc()] } },
  } as const;

  const rpcUrl = chain.rpc();
  const publicClient  = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  const walletClient  = createWalletClient({ account, chain: viemChain, transport: http(rpcUrl) });

  const erc20Abi = parseAbi([
    "function transfer(address to, uint256 amount) returns (bool)",
  ]);

  // Execute on-chain ERC-20 transfer
  const txHash = await walletClient.writeContract({
    address: offer.asset as `0x${string}`,
    abi: erc20Abi,
    functionName: "transfer",
    args: [offer.payTo as `0x${string}`, BigInt(offer.amount)],
  });

  // Wait for at least one block confirmation before presenting the credential
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Build x402 payment credential (standard spec format)
  const credential = Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: offer.network,
      payload: {
        txHash,
        payer: account.address,
        asset: offer.asset,
        amount: offer.amount,
      },
    }),
  ).toString("base64");

  const retryHeaders: Record<string, string> = {
    "X-Payment": credential,
    "PAYMENT-SIGNATURE": credential,
  };
  if (method === "POST") retryHeaders["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers: retryHeaders,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any = null;
  try { result = await res.json(); }
  catch { result = await res.text().catch(() => null); }

  return {
    receipt: {
      network: offer.network,
      amountUSDC: amountToUSD(offer.amount),
      asset: offer.asset,
      payer: account.address,
      reference: txHash,
      retried: false, // overwritten by consume402 spread at call-site
    },
    result,
    status: res.status,
  };
}

/** Route EVM payments: Base → Circle Gateway (gasless); other chains → viem generic. */
async function payEVM(
  offer: PaymentOffer,
  maxPriceUsd: number,
  url: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<ConsumeResult> {
  if (offer.network === CAIP2_BASE_MAINNET) {
    return payEVMBase(offer, maxPriceUsd, url, method, body);
  }
  return payEVMGeneric(offer, url, method, body);
}

// ── Solana payment (pay-kit) ───────────────────────────────────────────────────

/**
 * Solana payer — delegates to solPayFetchWithCap which uses the pay-kit client
 * configured with stablecoins: ["USDC", "PYUSD", "USDT", "USDG", "CASH"].
 * The pay-kit resolves the correct mint internally from the server's offer;
 * both USDC and USDT mints are already accepted.
 */
async function paySolana(
  offer: PaymentOffer,
  maxPriceUsd: number,
  url: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<ConsumeResult> {
  const { solPayFetchWithCap } = await import("@/lib/solana-pay-kit");

  const { status, data, error, payer } = await solPayFetchWithCap(
    url,
    maxPriceUsd,
    method,
    body,
  );

  if (status === 402 || !data) {
    throw new Error(error ?? "Solana payment failed — 402 not resolved");
  }

  return {
    receipt: {
      network: offer.network,
      amountUSDC: amountToUSD(offer.amount),
      asset: offer.asset,
      payer,
      reference:
        (data as Record<string, unknown>)?.reference as string ?? "solana-paid",
      retried: false, // overwritten by consume402 spread at call-site
    },
    result: data,
    status,
  };
}

// ── Main consumer ─────────────────────────────────────────────────────────────

/**
 * Consume a 402-protected URL.
 *
 * Flow:
 *   1. GET/POST the URL
 *   2. If 402 → parse PAYMENT-REQUIRED header
 *   3. Validate CAIP-2 and price cap; filter to known USDC/USDT assets only
 *   4. Select offer (highest score wins; Base USDC preferred)
 *   5. Sign once and send payment
 *   6. On transient error, retry once
 *   7. Return { receipt, result }
 *
 * Supported networks (all mainnet):
 *   EVM:    Base, Arbitrum, Optimism, Polygon, Avalanche, Ethereum
 *   Solana: Solana mainnet
 *
 * Supported tokens:
 *   EVM:    USDC, USDT (per-chain addresses in CHAIN_CONFIG)
 *   Solana: USDC, USDT, PYUSD, USDG, CASH (via pay-kit stablecoins config)
 */
export async function consume402(opts: ConsumeOffer): Promise<ConsumeResult> {
  const {
    url,
    method = "GET",
    body,
    maxPriceUsd = DEFAULT_MAX_PRICE_USD,
    allowedNetworks = ALLOWED_NETWORKS,
  } = opts;

  // Resolve relative URLs
  const absoluteUrl = url.startsWith("/")
    ? (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "") + url
    : url;

  let retried = false;

  async function attempt(): Promise<ConsumeResult> {
    // Step 1: probe the URL
    const probe = await fetch(absoluteUrl, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });

    // Not a 402 — return result directly (no payment needed)
    if (probe.status !== 402) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any = null;
      try { result = await probe.json(); }
      catch { result = await probe.text().catch(() => null); }
      return {
        receipt: {
          network: "none",
          amountUSDC: 0,
          asset: "none",
          payer: "none",
          reference: "no-payment-required",
          retried,
        },
        result,
        status: probe.status,
      };
    }

    // Step 2: parse 402 offers
    const header =
      probe.headers.get("payment-required") ??
      probe.headers.get("PAYMENT-REQUIRED") ?? "";

    if (!header) {
      throw new Error(
        "402 received but no PAYMENT-REQUIRED header found — cannot consume offer",
      );
    }

    const offers = parseOffers(header);
    if (offers.length === 0) {
      throw new Error(
        "PAYMENT-REQUIRED header is present but contains no parseable offers",
      );
    }

    // Step 3 & 4: validate and select best offer
    const offer = selectOffer(offers, maxPriceUsd, allowedNetworks);
    if (!offer) {
      const networks = offers.map((o) => o.network).join(", ");
      const prices   = offers.map((o) => `$${amountToUSD(o.amount).toFixed(6)}`).join(", ");
      const assets   = offers.map((o) => o.asset).join(", ");
      throw new Error(
        `No acceptable offer found. Available networks: [${networks}], ` +
        `assets: [${assets}], prices: [${prices}]. ` +
        `Allowed networks: [${[...allowedNetworks].join(", ")}], cap: $${maxPriceUsd}.`,
      );
    }

    // Step 5: dispatch to network-specific payer
    let result: ConsumeResult;

    if (isEVM(offer.network)) {
      result = await payEVM(offer, maxPriceUsd, absoluteUrl, method, body);
    } else if (isSolana(offer.network)) {
      result = await paySolana(offer, maxPriceUsd, absoluteUrl, method, body);
    } else {
      throw new Error(`Unsupported network type: ${offer.network}`);
    }

    return { ...result, receipt: { ...result.receipt, retried } };
  }

  // Step 6: retry once on transient errors
  try {
    return await attempt();
  } catch (err: unknown) {
    if (retried) throw err; // already retried, surface the error
    const msg = (err as Error)?.message ?? "";
    // Only retry on transient errors, not on validation / spend-mandate failures
    const isTransient =
      msg.includes("expired") ||
      msg.includes("ECONNRESET") ||
      msg.includes("fetch failed") ||
      msg.includes("network error") ||
      msg.includes("timeout");
    if (!isTransient) throw err;
    retried = true;
    return await attempt();
  }
}
