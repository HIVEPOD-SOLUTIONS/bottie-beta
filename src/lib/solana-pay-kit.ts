/**
 * Solana nanopayments via @solana/pay-kit (x402 / MPP protocol).
 *
 * The agent wallet is a dedicated Solana keypair stored in SOLANA_AGENT_PRIVATE_KEY
 * (base58-encoded 64-byte secret key — same format as Phantom's "export private key").
 * It is completely separate from the user's Privy Solana wallet.
 *
 * All operations run on Solana mainnet using the same RPC as Flash Trade.
 *
 * Gate catalogue (defined in getSolPayKit() pricing option):
 *   "charge"  — fixed $0.000001 USDC/call  (MPP) — protocol minimum
 *   "metered" — usage up to $0.10 USDC, $0.001/word  (x402 — required by SDK for usage gates)
 *   "weekly"  — $0.25 USDC/week subscription, planId: bluvfi-weekly-v1  (MPP)
 *   "dynamic" — DynamicGate, price from ?price= query param  (MPP, falls back to $0.01)
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const SOLANA_RPC =
  process.env.FLASH_SOLANA_RPC ||
  `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}` ||
  "https://api.mainnet-beta.solana.com";

// USDC mint on Solana mainnet
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ── Buyer: signer + client (cached per process) ───────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any | null = null;
let _address: string | null = null;

export async function getSolPayClient() {
  if (_client) return { client: _client, address: _address! };

  const secretKeyBase58 = process.env.SOLANA_AGENT_PRIVATE_KEY;
  if (!secretKeyBase58) throw new Error("SOLANA_AGENT_PRIVATE_KEY not configured");

  const { default: bs58 } = await import("bs58");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const secretBytes = bs58.decode(secretKeyBase58);
  const signer = await createKeyPairSignerFromBytes(secretBytes);

  const { createPayKitClient } = await import("@solana/pay-kit/client");
  _client = await createPayKitClient({
    signer,
    rpcUrl: SOLANA_RPC,
    // Both protocols: MPP for charge/subscription, x402 for usage gates
    accept: ["x402", "mpp"],
    // Log payment progress to console so server logs show payment flow
    onProgress: (event: unknown) => {
      console.debug("[solpay/client] progress:", JSON.stringify(event));
    },
  });
  _address = signer.address as string;

  return { client: _client, address: _address };
}

// ── Balance ───────────────────────────────────────────────────────────────────

export async function getSolPayBalance(): Promise<{
  address: string;
  sol: number;
  usdc: number;
}> {
  const { address } = await getSolPayClient();
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const pubkey = new PublicKey(address);

  const [lamports, tokenAccounts] = await Promise.all([
    connection.getBalance(pubkey),
    connection.getParsedTokenAccountsByOwner(pubkey, { mint: USDC_MINT }),
  ]);

  return {
    address,
    sol: lamports / LAMPORTS_PER_SOL,
    usdc: tokenAccounts.value[0]?.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0,
  };
}

// ── Transaction history ───────────────────────────────────────────────────────

export async function getSolPayTransaction(signature: string) {
  const { address } = await getSolPayClient();
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) return { error: "Transaction not found", signature };

  const meta = tx.meta;
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
  const fee = meta ? meta.fee / LAMPORTS_PER_SOL : null;
  const err = meta?.err ?? null;

  // Extract USDC token balance changes for the agent wallet
  const preBalances = meta?.preTokenBalances ?? [];
  const postBalances = meta?.postTokenBalances ?? [];
  const usdcChanges = postBalances
    .filter((b) => b.mint === USDC_MINT.toBase58())
    .map((post) => {
      const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
      const postAmt = post.uiTokenAmount.uiAmount ?? 0;
      const preAmt = pre?.uiTokenAmount.uiAmount ?? 0;
      return { accountIndex: post.accountIndex, delta: postAmt - preAmt };
    })
    .filter((c) => c.delta !== 0);

  return { signature, address, blockTime, fee, error: err, usdcChanges };
}

export async function searchSolPayTransactions(opts: { limit?: number; before?: string } = {}) {
  const { address } = await getSolPayClient();
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const pubkey = new PublicKey(address);

  const sigs = await connection.getSignaturesForAddress(pubkey, {
    limit: Math.min(opts.limit ?? 20, 100),
    ...(opts.before ? { before: opts.before } : {}),
  });

  return {
    address,
    transactions: sigs.map((s) => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
      confirmationStatus: s.confirmationStatus,
      err: s.err ?? null,
      memo: s.memo ?? null,
    })),
    count: sigs.length,
  };
}

// ── Seller: PayKit server instance (cached per process) ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _paykit: any | null = null;

export async function getSolPayKit() {
  if (_paykit) return _paykit;

  const sellerKey =
    process.env.SOLANA_SELLER_PRIVATE_KEY || process.env.SOLANA_AGENT_PRIVATE_KEY;
  if (!sellerKey)
    throw new Error("SOLANA_SELLER_PRIVATE_KEY (or SOLANA_AGENT_PRIVATE_KEY) not configured");

  const mppSecret =
    process.env.PAY_KIT_MPP_SECRET ??
    // Random fallback — fine for single-instance dev.
    // Production MUST set PAY_KIT_MPP_SECRET: a restart without it invalidates all outstanding challenges.
    crypto.randomUUID();

  const { default: bs58 } = await import("bs58");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const secretBytes = bs58.decode(sellerKey);
  const signer = await createKeyPairSignerFromBytes(secretBytes);
  const sellerAddress = signer.address as string;

  const { createPayKit, Store, usd, subscription, usage } = await import("@solana/pay-kit");

  // Optional fee recipient for platform fee splitting on charge gates.
  // Must be a different address from the seller — Gate.create enforces this.
  const feeRecipient = process.env.SOLANA_FEE_RECIPIENT;

  // "charge-with-fee" gate — only added when SOLANA_FEE_RECIPIENT is set.
  // feeOnTop: buyer pays $0.0000011 total; seller gets $0.000001, fee recipient gets $0.0000001.
  // Alternatively use feeWithin to split from the base amount instead of adding on top.
  // "fixed" is the canonical GateKind for a fixed-price charge gate
  const feeGate = feeRecipient
    ? { kind: "fixed" as const, amount: usd("0.000001"), feeOnTop: { [feeRecipient]: usd("0.0000001") } }
    : undefined;

  _paykit = await createPayKit({
    network: "solana_mainnet",
    // Both protocols required: MPP for charge/subscription/session, x402 required for usage gates
    accept: ["mpp", "x402"],
    // Custom RPC — avoids rate-limiting on the public mainnet endpoint
    rpcUrl: SOLANA_RPC,
    // Accept USDC, PYUSD, and USDT — server issues one 402 offer per stablecoin;
    // the buyer's wallet picks which one to settle in
    // Full stablecoin set supported by @solana/pay-kit: USDC, PYUSD, USDT, USDG, CASH
    stablecoins: ["USDC", "PYUSD", "USDT", "USDG", "CASH"],
    mpp: {
      challengeBindingSecret: mppSecret,
      expiresIn: 300, // 5-minute challenge window
      realm: "Bluvfi", // shown in wallet UI during payment
    },
    operator: {
      signer,
      feePayer: true,
      // operator.recipient defaults to signer.address — payments land here
    },
    // Anti-replay store: prevents a payment proof from being accepted twice.
    // Store.memory()    — single-process (default, dev)
    // Store.redis()     — multi-instance Node.js (set REDIS_URL)
    // Store.upstash()   — multi-instance serverless (set UPSTASH_REDIS_REST_URL + TOKEN)
    // Store.cloudflare() — Cloudflare Workers KV (pass KV namespace binding)
    replayStore: Store.memory(),
    onSettleError: (err: unknown) => {
      console.error("[solpay] settlement error:", err instanceof Error ? err.message : err);
    },
    // Named gate catalogue — all sell routes reference gates by string name.
    // Gate.create() is called internally, enforcing the correct protocol per gate type.
    pricing: {
      // Fixed $0.000001/call — MPP charge gate; settles in USDC, PYUSD, or USDT per buyer's choice
      // $0.000001 = 1 base unit (USDC has 6 decimals) — matches Circle NanoPayments protocol minimum
      charge: usd("0.000001"),

      // Metered up to $0.10 — x402 required by SDK for usage gates
      metered: usage(usd("0.10")),

      // $0.25/week recurring — MPP subscription gate
      // puller = operator pubkey that authorises renewal debits (required by MPP subscription spec)
      weekly: subscription(usd("0.25"), {
        planId: "bluvfi-weekly-v1",
        periodUnit: "week",
        periodCount: 1,
        puller: sellerAddress,
      }),

      // DynamicGate — price resolved per-request from ?price= query param (MPP)
      dynamic: async (req: Request) => {
        const raw = new URL(req.url).searchParams.get("price");
        const parsed = raw ? parseFloat(raw) : NaN;
        const amount = isFinite(parsed) && parsed > 0 ? parsed.toFixed(6) : "0.01";
        return usd(amount);
      },

      // Platform fee gate — only present when SOLANA_FEE_RECIPIENT is configured.
      // feeOnTop: buyer pays $0.011; seller keeps $0.01, fee recipient gets $0.001.
      // Gate.create() enforces that feeRecipient !== seller (throws ConfigurationError otherwise).
      ...(feeGate ? { "charge-with-fee": feeGate } : {}),
    },
  });

  return _paykit;
}

// ── Transfer USDC from agent wallet to another Solana address ─────────────────

export async function solPayTransfer(
  toAddress: string,
  amountUsdc: number,
): Promise<{ txSignature: string; fromAddress: string; toAddress: string; amountUsdc: number }> {
  const { address } = await getSolPayClient();

  const { default: bs58 } = await import("bs58");
  const { Connection, PublicKey, Transaction, sendAndConfirmTransaction, Keypair } = await import("@solana/web3.js");
  const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = await import("@solana/spl-token");

  const secretKeyBase58 = process.env.SOLANA_AGENT_PRIVATE_KEY!;
  const secretBytes = bs58.decode(secretKeyBase58);
  const payer = Keypair.fromSecretKey(secretBytes);

  const connection = new Connection(SOLANA_RPC, "confirmed");
  const fromPubkey = new PublicKey(address);
  const toPubkey = new PublicKey(toAddress);

  const [fromAta, toAta] = await Promise.all([
    getOrCreateAssociatedTokenAccount(connection, payer, USDC_MINT, fromPubkey),
    getOrCreateAssociatedTokenAccount(connection, payer, USDC_MINT, toPubkey),
  ]);

  const baseUnits = BigInt(Math.round(amountUsdc * 1_000_000));
  const ix = createTransferInstruction(fromAta.address, toAta.address, fromPubkey, baseUnits);

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);

  return { txSignature: sig, fromAddress: address, toAddress, amountUsdc };
}

// ── Spend-mandate helpers ─────────────────────────────────────────────────────

/**
 * Parse a compiled Solana message (legacy or v0) and return the largest SPL
 * Token Transfer / TransferChecked amount found in any instruction, in base
 * units (USDC has 6 decimals → $0.002 = 2_000 base units).
 *
 * Used by the cap-enforcing signer wrapper as a second-layer guard for the MPP
 * charge path (which fires no "challenge" progress event with amount).
 *
 * Returns null if no token transfer instruction is found or parsing fails.
 */
function largestTokenTransferInMessage(messageBytes: Uint8Array): bigint | null {
  try {
    // SPL Token program IDs (base58 → first 8 bytes as discriminant-free check)
    // We keep them as 32-byte Uint8Arrays derived from the account table in the message.
    const SPL_TOKEN_B58  = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const TOKEN_2022_B58 = "TokenzQdBNbLqP5VEhdkAS6EPFL4tBGZdcQRG2dfS";

    // Decode a base58 address to 32 bytes synchronously (hand-rolled, avoids async import)
    function b58ToBytes(s: string): Uint8Array {
      const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const out = new Uint8Array(32);
      let carry: bigint;
      const digits: bigint[] = [];
      for (const ch of s) {
        const idx = ALPHA.indexOf(ch);
        if (idx < 0) return new Uint8Array(0);
        digits.push(BigInt(idx));
      }
      // Convert base-58 digits to base-256
      const result: number[] = [];
      for (const d of digits) {
        carry = d;
        for (let i = result.length - 1; i >= 0; i--) {
          carry += BigInt(result[i]) * 58n;
          result[i] = Number(carry & 0xffn);
          carry >>= 8n;
        }
        while (carry > 0n) {
          result.unshift(Number(carry & 0xffn));
          carry >>= 8n;
        }
      }
      // Leading '1's → leading zero bytes
      let leadingZeros = 0;
      for (const ch of s) { if (ch === "1") leadingZeros++; else break; }
      const full = new Uint8Array(leadingZeros + result.length);
      full.set(result, leadingZeros);
      out.set(full.slice(-32));
      return out;
    }

    const splTokenBytes  = b58ToBytes(SPL_TOKEN_B58);
    const token2022Bytes = b58ToBytes(TOKEN_2022_B58);

    function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    // Compact-u16 reader (Solana wire format)
    let pos = 0;
    function readCompactU16(): number {
      let n = 0, shift = 0;
      while (pos < messageBytes.length) {
        const b = messageBytes[pos++];
        n |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      return n;
    }

    // V0 messages start with 0x80
    const isV0 = messageBytes[0] === 0x80;
    if (isV0) pos = 1;

    // Header: 3 bytes
    pos += 3;

    // Account keys
    const numAccounts = readCompactU16();
    const accounts: Uint8Array[] = [];
    for (let i = 0; i < numAccounts; i++) {
      accounts.push(messageBytes.slice(pos, pos + 32));
      pos += 32;
    }

    // Recent blockhash (32 bytes)
    pos += 32;

    // Instructions
    const numInstructions = readCompactU16();
    let largest: bigint | null = null;

    for (let i = 0; i < numInstructions; i++) {
      const programIdIdx = messageBytes[pos++];
      const numAccts = readCompactU16();
      pos += numAccts; // skip account indices
      const dataLen = readCompactU16();
      const data = messageBytes.slice(pos, pos + dataLen);
      pos += dataLen;

      // Check if this instruction targets the SPL Token or Token-2022 program
      const progKey = accounts[programIdIdx];
      if (!progKey) continue;
      const isToken = bytesEqual(progKey, splTokenBytes) || bytesEqual(progKey, token2022Bytes);
      if (!isToken) continue;

      // Instruction discriminant byte 0
      const disc = data[0];

      // Transfer (3): [3][amount:u64le] — 9 bytes
      if (disc === 3 && data.length >= 9) {
        const amt = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true);
        if (largest === null || amt > largest) largest = amt;
      }
      // TransferChecked (12): [12][amount:u64le][decimals:u8] — 10 bytes
      if (disc === 12 && data.length >= 10) {
        const amt = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true);
        if (largest === null || amt > largest) largest = amt;
      }
    }

    return largest;
  } catch {
    return null;
  }
}

/**
 * Build a fresh Pay-Kit client whose internal signer enforces `maxPriceUsd`
 * before any transaction is signed.
 *
 * Two enforcement layers — both run before any byte is signed:
 *
 *  Layer A — "challenge" progress event (x402 path):
 *    createPayKitClient fires { type: "challenge", amount } before calling
 *    createPaymentPayload. The amount is recorded. If it exceeds the cap,
 *    capBreached is set to true so the signer wrapper aborts immediately.
 *
 *  Layer B — signer wrapper (both x402 and MPP paths):
 *    signTransactions is called by the SDK (via @solana/kit's
 *    partiallySignTransactionMessageWithSigners) right before any signature
 *    is produced. Two checks run:
 *      1. capBreached flag (set by Layer A, or by a prior MPP check below)
 *      2. largestTokenTransferInMessage(): parse the compiled message bytes
 *         for SPL Token Transfer / TransferChecked instructions and compare
 *         the amount against the cap — this closes the MPP path gap where
 *         no "challenge" progress event fires with an amount.
 *
 * Layer B is the cryptographic guarantee: nothing can be signed that hasn't
 * passed the cap check. Layer A is an early-warning optimisation that avoids
 * building the transaction at all when the cap is already known to be exceeded.
 */
async function buildCapClient(maxPriceUsd: number): Promise<{
  client: { fetch: (url: string, init?: RequestInit) => Promise<Response> };
  address: string;
}> {
  const { default: bs58 } = await import("bs58");
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const { createPayKitClient } = await import("@solana/pay-kit/client");

  const secretKeyBase58 = process.env.SOLANA_AGENT_PRIVATE_KEY;
  if (!secretKeyBase58) throw new Error("SOLANA_AGENT_PRIVATE_KEY not configured");

  const secretBytes = bs58.decode(secretKeyBase58);
  const realSigner = await createKeyPairSignerFromBytes(secretBytes);
  const address = realSigner.address as string;

  const maxBaseUnits = BigInt(Math.round(maxPriceUsd * 1_000_000));

  // Shared mutable state for the two-layer cap
  let capBreached = false;
  let challengedAmount: bigint | null = null;

  // ── Cap-enforcing signer wrapper ─────────────────────────────────────────
  const capSigner = {
    address: realSigner.address,

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransactions: async <T extends { messageBytes?: Uint8Array }>(
      transactions: readonly T[],
    ): Promise<readonly T[]> => {
      // Layer A result: if "challenge" already fired with an over-cap amount
      if (capBreached) {
        const demanded =
          challengedAmount !== null
            ? `$${(Number(challengedAmount) / 1_000_000).toFixed(6)}`
            : "unknown";
        throw new Error(
          `Spend mandate exceeded at signing (Solana): server demands ${demanded} USDC but cap is $${maxPriceUsd}`,
        );
      }

      // Layer B: parse compiled message bytes for SPL Token transfer amounts
      for (const tx of transactions) {
        if (!(tx.messageBytes instanceof Uint8Array)) continue;
        const txAmount = largestTokenTransferInMessage(tx.messageBytes);
        if (txAmount !== null && txAmount > maxBaseUnits) {
          capBreached = true;
          throw new Error(
            `Spend mandate exceeded at signing (Solana): transaction transfers ` +
              `$${(Number(txAmount) / 1_000_000).toFixed(6)} USDC but cap is $${maxPriceUsd}`,
          );
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realSigner as any).signTransactions(transactions);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signMessages: (realSigner as any).signMessages?.bind(realSigner),
  };

  // ── Fresh Pay-Kit client with cap signer ─────────────────────────────────
  const client = await createPayKitClient({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signer: capSigner as any,
    rpcUrl: SOLANA_RPC,
    accept: ["x402", "mpp"],
    onProgress: (event: unknown) => {
      const ev = event as Record<string, unknown>;

      // Layer A: x402 path fires { type: "challenge", amount } before signing.
      // Record the challenged amount so the signer wrapper can abort without
      // even building or transmitting the transaction.
      if (ev?.type === "challenge" && ev?.amount != null) {
        challengedAmount = BigInt(String(ev.amount));
        if (challengedAmount > maxBaseUnits) {
          capBreached = true;
          // Don't throw here — onProgress is a fire-and-forget callback.
          // The signer wrapper will throw when signTransactions is called next.
          console.warn(
            `[x402-consumer] Solana challenge demands ${ev.amount} base units ` +
              `($${(Number(challengedAmount) / 1_000_000).toFixed(6)}) — ` +
              `cap is $${maxPriceUsd}. Aborting at signing.`,
          );
        }
      }

      // Forward to the standard console logger
      console.debug("[solpay/cap-client] progress:", JSON.stringify(event));
    },
  });

  return { client: client as unknown as { fetch: (url: string, init?: RequestInit) => Promise<Response> }, address };
}

// ── Pay (buyer fetches a protected URL) ───────────────────────────────────────

/**
 * Fetch a 402-protected Solana URL using the cached global client.
 * No spend-cap enforcement — use solPayFetchWithCap when a mandate is required.
 */
export async function solPayFetch(
  url: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown; paid: boolean; error?: string }> {
  // Resolve relative paths to absolute URLs — client.fetch requires an absolute URL in Node.js
  if (url.startsWith("/")) {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    url = base.replace(/\/$/, "") + url;
  }

  const { client } = await getSolPayClient();
  try {
    type PayFetch = (url: string, init?: RequestInit) => Promise<Response>;
    const init: RequestInit | undefined =
      method === "POST"
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
          }
        : undefined;
    const res = await (client as { fetch: PayFetch }).fetch(url, init);
    let data: unknown = null;
    try { data = await res.json(); } catch { data = await res.text().catch(() => null); }
    return { status: res.status, data, paid: res.status !== 402 };
  } catch (err: unknown) {
    const {
      ChallengeExpiredError, InvalidProofError, PaymentRequiredError,
      ProtocolNotSupportedError, ProtocolIncompatibleError,
      UnknownGateError, MixedCurrenciesError, DemoSignerOnMainnetError,
      InvalidKeyError, ConfigurationError, PayKitError,
    } = await import("@solana/pay-kit");
    if (err instanceof ChallengeExpiredError)
      return { status: 402, data: null, paid: false, error: "Payment challenge expired — retry the request" };
    if (err instanceof InvalidProofError)
      return { status: 402, data: null, paid: false, error: "Payment signature invalid or already used" };
    if (err instanceof PaymentRequiredError)
      return { status: 402, data: null, paid: false, error: "Payment required but no valid credential available" };
    if (err instanceof ProtocolNotSupportedError)
      return { status: 406, data: null, paid: false, error: "This URL does not support x402 or MPP payment protocols" };
    if (err instanceof ProtocolIncompatibleError)
      return { status: 406, data: null, paid: false, error: "Protocol version mismatch with this endpoint" };
    if (err instanceof UnknownGateError)
      return { status: 400, data: null, paid: false, error: "Unknown payment gate on this endpoint" };
    if (err instanceof MixedCurrenciesError)
      return { status: 400, data: null, paid: false, error: "Payment currencies do not match across fee recipients" };
    if (err instanceof DemoSignerOnMainnetError)
      return { status: 500, data: null, paid: false, error: "Demo signer cannot be used on mainnet — configure SOLANA_AGENT_PRIVATE_KEY" };
    if (err instanceof InvalidKeyError)
      return { status: 500, data: null, paid: false, error: "Agent signing key is invalid — check SOLANA_AGENT_PRIVATE_KEY" };
    if (err instanceof ConfigurationError)
      return { status: 400, data: null, paid: false, error: "Payment configuration error: " + (err instanceof Error ? err.message : String(err)) };
    if (err instanceof PayKitError)
      return { status: 500, data: null, paid: false, error: "PayKit error: " + (err instanceof Error ? err.message : String(err)) };
    throw err;
  }
}

/**
 * Fetch a 402-protected Solana URL with a hard spend cap enforced before any
 * signature is produced.
 *
 * Uses a fresh Pay-Kit client per call (not the cached global) so that the
 * cap-enforcing signer wrapper is scoped to this single invocation.
 *
 * Enforcement layers (see buildCapClient for full detail):
 *  A — "challenge" progress event records the demanded amount before signing
 *  B — signTransactions() parses compiled message bytes for SPL Token amounts
 *
 * Both layers fire before any EIP-3009 / Ed25519 signature is created. If
 * either layer detects a breach the call throws with a descriptive error that
 * propagates as `spend_mandate_exceeded` through paySolana → consume402.
 *
 * @param url         Absolute URL of the 402-protected resource
 * @param maxPriceUsd Hard ceiling in USD (e.g. 0.002 for $0.002)
 * @param method      HTTP method for the protected resource
 * @param body        Optional POST body
 */
export async function solPayFetchWithCap(
  url: string,
  maxPriceUsd: number,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown; paid: boolean; payer: string; error?: string }> {
  if (url.startsWith("/")) {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    url = base.replace(/\/$/, "") + url;
  }

  const { client, address } = await buildCapClient(maxPriceUsd);
  try {
    const init: RequestInit | undefined =
      method === "POST"
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
          }
        : undefined;
    const res = await client.fetch(url, init);
    let data: unknown = null;
    try { data = await res.json(); } catch { data = await res.text().catch(() => null); }
    return { status: res.status, data, paid: res.status !== 402, payer: address };
  } catch (err: unknown) {
    // Spend mandate breach — surface as a typed error, not a generic PayKit error
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Spend mandate exceeded")) {
      return { status: 402, data: null, paid: false, payer: address, error: msg };
    }

    const {
      ChallengeExpiredError, InvalidProofError, PaymentRequiredError,
      ProtocolNotSupportedError, ProtocolIncompatibleError,
      UnknownGateError, MixedCurrenciesError, DemoSignerOnMainnetError,
      InvalidKeyError, ConfigurationError, PayKitError,
    } = await import("@solana/pay-kit");
    if (err instanceof ChallengeExpiredError)
      return { status: 402, data: null, paid: false, payer: address, error: "Payment challenge expired — retry the request" };
    if (err instanceof InvalidProofError)
      return { status: 402, data: null, paid: false, payer: address, error: "Payment signature invalid or already used" };
    if (err instanceof PaymentRequiredError)
      return { status: 402, data: null, paid: false, payer: address, error: "Payment required but no valid credential available" };
    if (err instanceof ProtocolNotSupportedError)
      return { status: 406, data: null, paid: false, payer: address, error: "This URL does not support x402 or MPP payment protocols" };
    if (err instanceof ProtocolIncompatibleError)
      return { status: 406, data: null, paid: false, payer: address, error: "Protocol version mismatch with this endpoint" };
    if (err instanceof UnknownGateError)
      return { status: 400, data: null, paid: false, payer: address, error: "Unknown payment gate on this endpoint" };
    if (err instanceof MixedCurrenciesError)
      return { status: 400, data: null, paid: false, payer: address, error: "Payment currencies do not match across fee recipients" };
    if (err instanceof DemoSignerOnMainnetError)
      return { status: 500, data: null, paid: false, payer: address, error: "Demo signer cannot be used on mainnet — configure SOLANA_AGENT_PRIVATE_KEY" };
    if (err instanceof InvalidKeyError)
      return { status: 500, data: null, paid: false, payer: address, error: "Agent signing key is invalid — check SOLANA_AGENT_PRIVATE_KEY" };
    if (err instanceof ConfigurationError)
      return { status: 400, data: null, paid: false, payer: address, error: "Payment configuration error: " + msg };
    if (err instanceof PayKitError)
      return { status: 500, data: null, paid: false, payer: address, error: "PayKit error: " + msg };
    throw err;
  }
}
