"use client";

import { createPublicClient, createWalletClient, custom, http, erc20Abi, type Hex } from "viem";
import { base } from "viem/chains";
import type { ConnectedWallet } from "@privy-io/react-auth";
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import { authFetch } from "@/lib/api-auth-fetch";
import type {
  CrOrderRequest,
  CrOrderStatus,
  CrPhase1,
  CrRail,
  CrPartnerRequest,
  CrPartnerOrder,
  CrPartnerStatus,
} from "@/lib/cryptorefills";

/**
 * Browser half of the Cryptorefills checkout, shared by the Bills screen and
 * the AI chat's payment card.
 *
 * Gasless x402 (USDC):
 *   Base   — the Privy EVM wallet signs an EIP-3009 transferWithAuthorization
 *            (a signature, not a transaction); Cryptorefills relays it.
 *   Solana — the Privy Solana wallet partially signs a v0 USDC transfer whose
 *            fee payer is Cryptorefills' facilitator, which pays the SOL fee.
 * Partner API (any other coin): creates an order and returns a deposit address
 * for the user to send to from any wallet or exchange.
 */

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE_RPC = `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
const SOLANA_RPC = `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;

type GetAccessToken = () => Promise<string | null>;
export type CrPayStep = "quoting" | "signing" | "settling";

export const RAIL_LABEL: Record<CrRail, string> = { base: "Base", solana: "Solana" };

export function pickEvmWallet(wallets: ConnectedWallet[]): ConnectedWallet | undefined {
  return wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
}

export async function usdcBalanceOnBase(address: string): Promise<number> {
  const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const bal = await client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address as Hex] });
  return Number(bal) / 1e6;
}

export async function usdcBalanceOnSolana(owner: string): Promise<number> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { getAssociatedTokenAddress } = await import("@solana/spl-token");
  const conn = new Connection(SOLANA_RPC, "confirmed");
  const ata = await getAssociatedTokenAddress(new PublicKey(SOLANA_USDC), new PublicKey(owner));
  const bal = await conn.getTokenAccountBalance(ata).catch(() => null); // no ATA yet → 0
  return bal ? Number(bal.value.amount) / 1e6 : 0;
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Turns wallet/network errors into one short sentence for the user. */
export function friendlyPayError(err: unknown): string {
  const m = (err as Error)?.message ?? "Payment failed.";
  if (/reject|denied|cancel/i.test(m)) return "You cancelled the signature. Nothing was charged.";
  if (/blockhash|expired/i.test(m)) return "The payment window closed before it was sent. Nothing was charged. Please try again.";
  return m.split("\n")[0];
}

async function signBase(phase1: CrPhase1, wallet: ConnectedWallet): Promise<string> {
  const { requirement, expiresAt } = phase1;
  try { await wallet.switchChain(base.id); } catch { /* signing typed data doesn't need the active chain */ }
  const provider = await wallet.getEthereumProvider();
  const walletClient = createWalletClient({ chain: base, transport: custom(provider) });
  const from = wallet.address as Hex;
  const authorization = {
    from,
    to: requirement.payTo as Hex,
    value: BigInt(requirement.maxAmountRequired),
    validAfter: BigInt(0),
    validBefore: BigInt(expiresAt),
    nonce: randomNonce(),
  };
  const signature = await walletClient.signTypedData({
    account: from,
    domain: {
      name: requirement.extra?.name ?? "USD Coin",
      version: requirement.extra?.version ?? "2",
      chainId: base.id,
      verifyingContract: BASE_USDC,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  return b64url(JSON.stringify({
    x402Version: 2,
    scheme: "exact",
    network: requirement.network,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: "0",
        validBefore: authorization.validBefore.toString(),
      },
    },
  }));
}

/**
 * Cryptorefills' Solana recipe: exactly 3 instructions (compute-unit limit,
 * compute-unit price, SPL TransferChecked), payerKey = extra.feePayer, fresh
 * blockhash, partially signed by the user — the facilitator signs the fee slot.
 */
async function signSolana(phase1: CrPhase1, wallet: ConnectedStandardSolanaWallet): Promise<string> {
  const { requirement } = phase1;
  const feePayerKey = requirement.extra?.feePayer;
  if (!feePayerKey) throw new Error("Payment request is missing the Solana fee payer.");
  const { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
  const { createTransferCheckedInstruction, getAssociatedTokenAddress } = await import("@solana/spl-token");

  const mint = new PublicKey(requirement.asset);
  const owner = new PublicKey(wallet.address);
  const senderAta = await getAssociatedTokenAddress(mint, owner);
  const recipientAta = await getAssociatedTokenAddress(mint, new PublicKey(requirement.payTo)); // payTo is the OWNER
  const conn = new Connection(SOLANA_RPC, "confirmed");
  const { blockhash } = await conn.getLatestBlockhash("finalized"); // re-fetched right before signing (~60s window)

  const message = new TransactionMessage({
    payerKey: new PublicKey(feePayerKey),
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
      createTransferCheckedInstruction(senderAta, mint, recipientAta, owner, BigInt(requirement.maxAmountRequired), 6),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (tx.message.compiledInstructions.length !== 3) throw new Error("Unexpected Solana transaction shape.");

  const { signedTransaction } = await wallet.signTransaction({ transaction: tx.serialize() });
  if (signedTransaction.length > 1232) throw new Error("Solana transaction too large.");
  return b64url(JSON.stringify({
    x402Version: 2,
    scheme: "exact",
    network: requirement.network,
    payload: { transaction: bytesToB64(signedTransaction) }, // inner: plain base64; outer: base64url
  }));
}

/**
 * Runs the whole gasless payment: balance check → Phase 1 (verified 402) →
 * sign → Phase 2. If the final price is more than 3% (+$0.10) above
 * `expectedUsd`, `confirmPriceChange` decides whether to go on. Returns the
 * order receipt, or null if the user declined the new price.
 */
export async function payCryptorefillsOrder(opts: {
  order: CrOrderRequest;
  productName: string;
  expectedUsd: number;
  rail: CrRail;
  evmWallet?: ConnectedWallet;
  solanaWallet?: ConnectedStandardSolanaWallet;
  getAccessToken: GetAccessToken;
  onStep?: (step: CrPayStep) => void;
  confirmPriceChange: (newUsd: number) => Promise<boolean>;
}): Promise<CrOrderStatus | null> {
  const { order, productName, expectedUsd, rail, evmWallet, solanaWallet, getAccessToken, onStep, confirmPriceChange } = opts;

  const address = rail === "solana" ? solanaWallet?.address : evmWallet?.address;
  if (!address) throw new Error(`No ${RAIL_LABEL[rail]} wallet connected.`);
  const balance = rail === "solana" ? await usdcBalanceOnSolana(address) : await usdcBalanceOnBase(address);
  if (balance < expectedUsd) {
    throw new Error(`You need $${expectedUsd.toFixed(2)} USDC on ${RAIL_LABEL[rail]} but have $${balance.toFixed(2)}. Add funds and try again.`);
  }

  onStep?.("quoting");
  const quoteRes = await authFetch("/api/cryptorefills/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phase: "quote", order, rail }),
  }, getAccessToken);
  const quote = await quoteRes.json();
  if (!quoteRes.ok) throw new Error(quote.error ?? "Couldn't start the order.");
  const phase1 = quote as CrPhase1;

  // Never sign more than the user saw without asking again.
  const amount = Number(phase1.requirement.maxAmountRequired) / 1e6;
  if (amount > expectedUsd * 1.03 + 0.1 && !(await confirmPriceChange(amount))) return null;

  onStep?.("signing");
  const paymentSignature = rail === "solana" ? await signSolana(phase1, solanaWallet!) : await signBase(phase1, evmWallet!);

  onStep?.("settling");
  const body = JSON.stringify({ phase: "pay", order, rail, sessionId: phase1.sessionId, paymentSignature, productName });
  // 503 = facilitator unreachable, nothing charged; the same signature may be retried.
  for (let attempt = 0; ; attempt++) {
    const res = await authFetch("/api/cryptorefills/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body }, getAccessToken);
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data.order as CrOrderStatus;
    if (res.status === 503 && data.retryable && attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    throw new Error(data.error ?? "Payment failed.");
  }
}

/**
 * Polls a gasless order until completed/failed/expired, or 10 minutes pass
 * (then resolves with the last status seen). Stops early if `signal` aborts.
 */
export async function pollCryptorefillsOrder(
  orderId: string,
  getAccessToken: GetAccessToken,
  opts: { onUpdate?: (o: CrOrderStatus) => void; signal?: AbortSignal } = {},
): Promise<CrOrderStatus | null> {
  const started = Date.now();
  let last: CrOrderStatus | null = null;
  while (Date.now() - started < 10 * 60_000 && !opts.signal?.aborted) {
    await new Promise((r) => setTimeout(r, 5000));
    if (opts.signal?.aborted) break;
    try {
      const res = await authFetch(`/api/cryptorefills/orders/${encodeURIComponent(orderId)}`, undefined, getAccessToken);
      const data = await res.json();
      if (res.ok && data.order) {
        last = data.order as CrOrderStatus;
        opts.onUpdate?.(last);
        if (last.status !== "processing") return last;
      }
    } catch { /* transient — keep polling */ }
  }
  return last;
}

// ── Partner API: any coin via deposit address ────────────────────────────────

export async function validatePartnerOrder(order: CrPartnerRequest, getAccessToken: GetAccessToken): Promise<{ coin_amount?: string; coin?: string }> {
  const res = await authFetch("/api/cryptorefills/partner-orders", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "validate", order }),
  }, getAccessToken);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Couldn't check this order.");
  return data;
}

export async function createPartnerOrder(
  order: CrPartnerRequest, priceUsd: number, productName: string, getAccessToken: GetAccessToken,
): Promise<CrPartnerOrder> {
  const res = await authFetch("/api/cryptorefills/partner-orders", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", order, priceUsd, productName }),
  }, getAccessToken);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Couldn't create the order.");
  return data.order as CrPartnerOrder;
}

/**
 * Polls a deposit-address order every 15s until it's delivered, failed or
 * expired. Payment windows run 1–3 hours, so this keeps going for 3 hours or
 * until `signal` aborts (e.g. the sheet closes — the order keeps working and
 * the code is emailed).
 */
export async function pollPartnerOrder(
  orderId: string,
  getAccessToken: GetAccessToken,
  opts: { onUpdate?: (o: CrPartnerStatus) => void; signal?: AbortSignal } = {},
): Promise<CrPartnerStatus | null> {
  const started = Date.now();
  let last: CrPartnerStatus | null = null;
  while (Date.now() - started < 3 * 60 * 60_000 && !opts.signal?.aborted) {
    await new Promise((r) => setTimeout(r, 15_000));
    if (opts.signal?.aborted) break;
    try {
      const res = await authFetch(`/api/cryptorefills/partner-orders/${encodeURIComponent(orderId)}`, undefined, getAccessToken);
      const data = await res.json();
      if (res.ok && data.order) {
        last = data.order as CrPartnerStatus;
        opts.onUpdate?.(last);
        if (["completed", "failed", "expired"].includes(last.status)) return last;
      }
    } catch { /* transient — keep polling */ }
  }
  return last;
}
