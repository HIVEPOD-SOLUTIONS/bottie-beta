/**
 * The business treasury wallet on Arc mainnet.
 *
 * custody "circle" (the default whenever CIRCLE_API_KEY and
 * CIRCLE_ENTITY_SECRET are set): a Circle developer-controlled wallet. Circle
 * generates and holds the key; Bluvfi only asks Circle to send USDC or sign a
 * message for that wallet. Transfers carry an idempotency key that is stored
 * before the call, so a retry can never pay twice.
 *
 * custody "local" (fallback, and any treasury created before Circle was set
 * up): a key Bluvfi generated, stored only encrypted (secret-box, bound to the
 * business id) and decrypted just for the moment of signing.
 *
 * USDC is Arc's gas token, so a treasury needs nothing but USDC; a small
 * buffer is always left for the network fee.
 */

import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arcChain, ARC_USDC, arcTxUrl } from "@/lib/arc-chain";
import { decryptSecret, encryptSecret, secretsEnabled } from "@/lib/secret-box";
import { getServerEnv } from "@/lib/server-env";

/** Left in the treasury for Arc network fees (paid in USDC). */
export const GAS_BUFFER_USD = 0.05;
const CIRCLE_ARC = "ARC";
/** How long a payment waits for Arc to confirm before the run moves on (the next run settles it). */
const CONFIRM_WAIT_MS = 10_000;

export type Custody = "circle" | "local";
export interface TreasuryRow {
  id: string;
  treasuryAddress: string;
  custody: string;
  circleWalletId: string | null;
  encryptedKey: string | null;
}

const publicClient = () => createPublicClient({ chain: arcChain, transport: http() });

// ── Circle developer-controlled wallets ──────────────────────────────────────

export function circleConfigured(): boolean {
  return !!getServerEnv("CIRCLE_API_KEY") && !!getServerEnv("CIRCLE_ENTITY_SECRET");
}

type CircleClient = Awaited<ReturnType<typeof makeCircle>>;
let circleClient: Promise<CircleClient> | null = null;
async function makeCircle() {
  const { initiateDeveloperControlledWalletsClient } = await import("@circle-fin/developer-controlled-wallets");
  return initiateDeveloperControlledWalletsClient({
    apiKey: getServerEnv("CIRCLE_API_KEY")!,
    entitySecret: getServerEnv("CIRCLE_ENTITY_SECRET")!,
  });
}
function circle(): Promise<CircleClient> {
  if (!circleConfigured()) throw new Error("Circle wallets aren't configured on this server (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET).");
  circleClient ??= makeCircle();
  return circleClient;
}

function circleError(err: unknown): string {
  const e = err as { response?: { data?: { message?: string; code?: number } }; message?: string };
  const m = e?.response?.data?.message ?? e?.message ?? String(err);
  return e?.response?.data?.code ? `Circle ${e.response.data.code}: ${m}` : m;
}

/** Creates a new treasury: a Circle wallet on Arc if configured, otherwise a locally held key. */
export async function newTreasury(label: string): Promise<{ id: string; address: string; custody: Custody; circleWalletId: string | null; encryptedKey: string | null }> {
  const id = randomUUID();
  if (circleConfigured()) {
    const c = await circle();
    try {
      // One wallet set per business keeps each treasury separable in the Circle Console.
      // Circle answers "API parameter invalid" to non-ASCII wallet-set names and to
      // punctuation such as parentheses in wallet metadata names, so keep both plain.
      const asciiLabel = label.replace(/[^ -~]/g, "").trim() || "business";
      const set = await c.createWalletSet({ name: `Bluvfi - ${asciiLabel}`.slice(0, 80), idempotencyKey: randomUUID() });
      const walletSetId = set.data?.walletSet?.id;
      if (!walletSetId) throw new Error("no wallet set id returned");
      const res = await c.createWallets({ walletSetId, blockchains: [CIRCLE_ARC], count: 1, accountType: "EOA", idempotencyKey: randomUUID(), metadata: [{ name: (asciiLabel.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "business").slice(0, 50), refId: id }] });
      const w = res.data?.wallets?.[0];
      if (!w?.id || !w.address) throw new Error("no wallet returned");
      return { id, address: w.address, custody: "circle", circleWalletId: w.id, encryptedKey: null };
    } catch (err) {
      throw new Error(`Couldn't create the Circle wallet: ${circleError(err)}`);
    }
  }
  if (!secretsEnabled()) throw new Error("Business treasuries need Circle wallets (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET) or PROVIDER_SECRET_KEY set on the server.");
  const key = generatePrivateKey();
  return { id, address: privateKeyToAccount(key).address, custody: "local", circleWalletId: null, encryptedKey: encryptSecret(key, `business:${id}`) };
}

function localAccount(b: TreasuryRow): PrivateKeyAccount {
  const key = b.encryptedKey ? decryptSecret(b.encryptedKey, `business:${b.id}`) : null;
  if (!key) throw new Error("This treasury's key can't be read on this server.");
  const account = privateKeyToAccount(key as Hex);
  if (account.address.toLowerCase() !== b.treasuryAddress.toLowerCase()) throw new Error("Treasury key mismatch.");
  return account;
}

/** EIP-191 personal_sign of `message` by the treasury address (verifiable with viem's verifyMessage). */
export async function signTreasuryMessage(b: TreasuryRow, message: string): Promise<Hex> {
  if (b.custody === "circle") {
    const c = await circle();
    try {
      const res = await c.signMessage({ walletId: b.circleWalletId!, message, memo: "Bluvfi treasury decision log entry" });
      const sig = res.data?.signature;
      if (!sig) throw new Error("no signature returned");
      return sig as Hex;
    } catch (err) {
      throw new Error(`Circle couldn't sign the log entry: ${circleError(err)}`);
    }
  }
  return localAccount(b).signMessage({ message });
}

/** USDC held by the treasury on Arc (read on-chain, the same for both custody types). */
export async function treasuryBalance(address: string): Promise<number> {
  const raw = await publicClient().readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address as Hex] });
  return Number(formatUnits(raw, 6));
}

export type PaymentState = "success" | "pending" | "failed";
export interface PaymentResult { state: PaymentState; txHash: string | null; providerTxId: string | null; error?: string }

const CIRCLE_DONE = new Set(["COMPLETE", "CONFIRMED"]);
const CIRCLE_FAILED = new Set(["FAILED", "DENIED", "CANCELLED"]);

async function circleStatus(providerTxId: string): Promise<PaymentResult> {
  const c = await circle();
  const res = await c.getTransaction({ id: providerTxId });
  const tx = res.data?.transaction;
  const state = String(tx?.state ?? "");
  const txHash = tx?.txHash ?? null;
  if (CIRCLE_DONE.has(state)) return { state: "success", txHash, providerTxId };
  if (CIRCLE_FAILED.has(state)) return { state: "failed", txHash, providerTxId, error: `${state}${tx?.errorReason ? `: ${tx.errorReason}` : ""}` };
  return { state: "pending", txHash, providerTxId };
}

async function waitCircle(providerTxId: string, ms: number): Promise<PaymentResult> {
  const until = Date.now() + ms;
  let last: PaymentResult = { state: "pending", txHash: null, providerTxId };
  while (Date.now() < until) {
    last = await circleStatus(providerTxId).catch(() => last);
    if (last.state !== "pending") return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/**
 * Sends USDC on Arc from the treasury and waits up to ~10 s for the outcome (Arc settles in well under a second; a run also spends time on the
 * model, and the whole request has to finish inside the server's limit, so a slower payment is settled by the next run instead).
 * `idempotencyKey` (a UUID the caller stored first) makes Circle refuse to
 * send twice for the same payment, even across crashes and retries.
 */
export async function sendTreasuryUsdc(b: TreasuryRow, to: string, amountUsd: number, idempotencyKey: string): Promise<PaymentResult> {
  if (b.custody === "circle") {
    const c = await circle();
    let providerTxId: string | undefined;
    try {
      // A token named by its address also needs its chain ("Blockchain of the transferred token. Required if tokenId is not provided"),
      // or Circle answers "API parameter invalid" and no payment can ever leave a Circle treasury. The SDK's input type forbids
      // `blockchain` next to `walletId`, but the API takes it, so it is added through a typed spread.
      const tokenChain = { blockchain: CIRCLE_ARC } as unknown as Record<string, never>;
      const res = await c.createTransaction({
        walletId: b.circleWalletId!,
        tokenAddress: ARC_USDC,
        ...tokenChain,
        amount: [amountUsd.toFixed(6).replace(/\.?0+$/, "")],
        destinationAddress: to,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey,
      });
      providerTxId = res.data?.id;
    } catch (err) {
      return { state: "failed", txHash: null, providerTxId: null, error: circleError(err) };
    }
    if (!providerTxId) return { state: "failed", txHash: null, providerTxId: null, error: "Circle returned no transaction id" };
    return waitCircle(providerTxId, CONFIRM_WAIT_MS);
  }
  const account = localAccount(b);
  const wallet = createWalletClient({ account, chain: arcChain, transport: http() });
  let hash: Hex;
  try {
    hash = await wallet.writeContract({ address: ARC_USDC, abi: erc20Abi, functionName: "transfer", args: [to as Hex, parseUnits(amountUsd.toFixed(6), 6)] });
  } catch (err) {
    return { state: "failed", txHash: null, providerTxId: null, error: err instanceof Error ? err.message : String(err) };
  }
  const outcome = await txOutcome(hash, CONFIRM_WAIT_MS);
  return { state: outcome === "success" ? "success" : outcome === "reverted" ? "failed" : "pending", txHash: hash, providerTxId: null, ...(outcome === "reverted" ? { error: "reverted on-chain" } : {}) };
}

/** Current outcome of a payment started earlier (for reconciling in-flight payments). */
export async function paymentStatus(b: TreasuryRow, p: { txHash: string | null; providerTxId: string | null }): Promise<PaymentResult> {
  if (b.custody === "circle" && p.providerTxId) return circleStatus(p.providerTxId).catch(() => ({ state: "pending" as const, txHash: p.txHash, providerTxId: p.providerTxId }));
  if (!p.txHash) return { state: "pending", txHash: null, providerTxId: p.providerTxId };
  const o = await txOutcome(p.txHash);
  return { state: o === "success" ? "success" : o === "reverted" ? "failed" : "pending", txHash: p.txHash, providerTxId: p.providerTxId };
}

/** "success" | "reverted" | null (not mined yet / unknown). */
export async function txOutcome(hash: string, waitMs = 0): Promise<"success" | "reverted" | null> {
  try {
    const receipt = waitMs > 0
      ? await publicClient().waitForTransactionReceipt({ hash: hash as Hex, timeout: waitMs })
      : await publicClient().getTransactionReceipt({ hash: hash as Hex });
    return receipt.status;
  } catch {
    return null;
  }
}

export { arcTxUrl };
