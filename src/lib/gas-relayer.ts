import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  isHex,
  parseAbi,
  parseSignature,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import { getServerEnv } from "@/lib/server-env";
import { getUserWalletAddresses } from "@/lib/auth";

/**
 * Gasless USDC transfers for the mobile app's payment "layer 1".
 *
 * The user's wallet signs an EIP-3009 `transferWithAuthorization` (a signature, not a transaction) and
 * Bluvfi's relayer account submits it, paying the gas. The signature authorises exactly one transfer of
 * USDC from the user to one recipient, so the relayer can never move more, or elsewhere. Only native USDC
 * on the chains below (all of which implement EIP-3009) is supported; anything else falls to the app's next
 * layer (the user's own gas).
 *
 * Entirely additive and OFF by default: with no GAS_RELAYER_PRIVATE_KEY the route reports it is disabled and
 * nothing else in the app is affected.
 *
 * Env:
 *   GAS_RELAYER_PRIVATE_KEY   0x… key of a funded EOA on each enabled chain (native token pays the gas)
 *   GAS_RELAYER_MAX_USDC      per-transfer cap in USDC (default 500)
 *   NEXT_PUBLIC_ALCHEMY_API_KEY  (optional) RPC; falls back to each chain's public RPC
 */

interface RelayChain {
  chain: Chain;
  usdc: Hex;
  alchemy: string;
}

export const RELAY_CHAINS: Record<number, RelayChain> = {
  8453: { chain: base, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", alchemy: "base-mainnet" },
  1: { chain: mainnet, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", alchemy: "eth-mainnet" },
  137: { chain: polygon, usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", alchemy: "polygon-mainnet" },
  42161: { chain: arbitrum, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", alchemy: "arb-mainnet" },
  10: { chain: optimism, usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", alchemy: "opt-mainnet" },
};

const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

/** A relay request failed in a way the client should treat as "fall through to the next layer". */
export class RelayError extends Error {
  constructor(
    public readonly code: "RELAY_DISABLED" | "RELAY_UNFUNDED" | "RATE_LIMITED" | "INVALID_REQUEST" | "NOT_ALLOWED" | "FAILED",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

function relayerKey(): Hex | null {
  const raw = getServerEnv("GAS_RELAYER_PRIVATE_KEY");
  if (!raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
}

export function relayEnabled(): boolean {
  return relayerKey() !== null;
}

/** Per-transfer cap in atomic USDC (6 decimals). */
export function relayMaxAtomic(): bigint {
  const max = Number(getServerEnv("GAS_RELAYER_MAX_USDC") ?? 500);
  return BigInt(Math.round((Number.isFinite(max) && max > 0 ? max : 500) * 1_000_000));
}

function publicClient(chainId: number) {
  const c = RELAY_CHAINS[chainId];
  const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  return createPublicClient({ chain: c.chain, transport: http(key ? `https://${c.alchemy}.g.alchemy.com/v2/${key}` : undefined) });
}

// ── Abuse limits (per user, in-process — same approach as lib/user-rate-limiter.ts) ─────────────────────

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const LIMITS = [
  { windowMs: HOUR, max: 20 },
  { windowMs: DAY, max: 60 },
];
const hits = new Map<string, number[]>();

function checkRateLimit(userId: string) {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < DAY);
  for (const { windowMs, max } of LIMITS) {
    if (recent.filter((t) => now - t < windowMs).length >= max) {
      throw new RelayError("RATE_LIMITED", "Too many gasless transfers. Try again later.", 429);
    }
  }
  recent.push(now);
  hits.set(userId, recent);
}

// ── Relay ───────────────────────────────────────────────────────────────────────────────────────────────

export interface RelayRequest {
  chainId: number;
  from: string;
  to: string;
  /** Atomic USDC as a decimal string. */
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
}

export async function relayUsdcTransfer(userId: string, req: RelayRequest): Promise<{ hash: Hex; chainId: number }> {
  const key = relayerKey();
  if (!key) throw new RelayError("RELAY_DISABLED", "Gasless transfers aren't enabled.", 501);

  const chain = RELAY_CHAINS[req.chainId];
  if (!chain) throw new RelayError("INVALID_REQUEST", "That network isn't supported for gasless transfers.", 400);
  if (!isAddress(req.from) || !isAddress(req.to)) throw new RelayError("INVALID_REQUEST", "Invalid address.", 400);
  if (!isHex(req.nonce, { strict: true }) || req.nonce.length !== 66) throw new RelayError("INVALID_REQUEST", "Invalid nonce.", 400);
  if (!isHex(req.signature, { strict: true })) throw new RelayError("INVALID_REQUEST", "Invalid signature.", 400);

  let value: bigint;
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    value = BigInt(req.value);
    validAfter = BigInt(req.validAfter);
    validBefore = BigInt(req.validBefore);
  } catch {
    throw new RelayError("INVALID_REQUEST", "Invalid amount or time window.", 400);
  }
  if (value <= BigInt(0)) throw new RelayError("INVALID_REQUEST", "Amount must be positive.", 400);
  if (value > relayMaxAtomic()) throw new RelayError("NOT_ALLOWED", "That amount is above the gasless limit.", 400);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (validAfter > now) throw new RelayError("INVALID_REQUEST", "Authorization isn't valid yet.", 400);
  if (validBefore <= now) throw new RelayError("INVALID_REQUEST", "Authorization expired.", 400);
  if (validBefore > now + BigInt(30 * 60)) throw new RelayError("INVALID_REQUEST", "Authorization window is too long.", 400);

  // Only spend gas on the signed-in user's own Bluvfi wallet.
  const { evm } = await getUserWalletAddresses(userId);
  if (!evm.includes(req.from.toLowerCase())) throw new RelayError("NOT_ALLOWED", "That wallet doesn't belong to your account.", 403);

  checkRateLimit(userId);

  const account = privateKeyToAccount(key);
  const pub = publicClient(req.chainId);
  const { r, s, v, yParity } = parseSignature(req.signature as Hex);
  const vByte = Number(v ?? BigInt(27 + (yParity ?? 0)));
  const args = [
    getAddress(req.from),
    getAddress(req.to),
    value,
    validAfter,
    validBefore,
    req.nonce as Hex,
    vByte,
    r,
    s,
  ] as const;

  // The relayer needs native gas on this chain.
  const [balance, gasPrice] = await Promise.all([pub.getBalance({ address: account.address }), pub.getGasPrice()]);
  if (balance < gasPrice * BigInt(250_000)) throw new RelayError("RELAY_UNFUNDED", "Gasless transfers are unavailable right now.", 503);

  // Simulate first: a bad signature, used nonce or short balance fails here without spending gas.
  try {
    await pub.simulateContract({ account, address: chain.usdc, abi: USDC_ABI, functionName: "transferWithAuthorization", args });
  } catch (err) {
    const msg = (err as { shortMessage?: string; message?: string })?.shortMessage ?? (err as Error)?.message ?? "";
    console.warn("[gas-relayer] simulation failed:", msg.split("\n")[0]);
    throw new RelayError("FAILED", "The transfer would fail (balance, signature or nonce). Nothing was sent.", 422);
  }

  const wallet = createWalletClient({
    account,
    chain: chain.chain,
    transport: http(process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ? `https://${chain.alchemy}.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}` : undefined),
  });
  const hash = await wallet.writeContract({ address: chain.usdc, abi: USDC_ABI, functionName: "transferWithAuthorization", args });
  return { hash, chainId: req.chainId };
}
