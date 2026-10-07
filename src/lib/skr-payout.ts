import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  PAYMENTS,
  SKR_DECIMALS,
  SKR_MINT,
  USDC_MINT,
  driftBps,
  isPayableAddress,
  microToDecimal,
  skrToMicro,
  usdPerSkr,
  type PayoutKind,
} from "@/lib/payments-rules";
import { assessRisk } from "@/lib/abuse";
import type { RiskAssessment, RiskFlag } from "@/lib/abuse-rules";
import { getServerEnv } from "@/lib/server-env";
import { solanaRpcUrl } from "@/lib/solana-server";

/**
 * Sending SKR to people: Shar claims (a fixed SKR amount) and commission withdrawals (SKR worth a USD amount, priced when an
 * admin clicks Pay). A PERSON CLICKS EVERY PAYOUT. Nothing here runs on its own.
 *
 * The one rule that matters: a payout is never sent twice.
 *
 *   requested ──claim──▶ processing ──sign, SAVE signature──▶ sent ──broadcast, confirm──▶ paid
 *        ▲                    │                                │
 *        └──────released──────┴────────── released ────────────┘   (only when it provably did not happen)
 *
 *  • Moving requested → processing is one atomic UPDATE, so two simultaneous clicks can't both start.
 *  • The signed transaction's signature and last valid block height are saved BEFORE it is broadcast. If the server dies at any
 *    point after that, the payout sits in "sent" and nothing is ever re-sent blindly.
 *  • A "sent" payout goes back to "requested" only when (a) the chain shows the transaction failed, or (b) the chain is past the
 *    transaction's last valid block, which proves it can never land. Only then can a fresh transaction be made.
 */

// ── Chain access (injectable, so tests can simulate every failure) ────────────

export interface PayoutChain {
  treasuryAddress(): string;
  balances(): Promise<{ skrMicro: bigint; lamports: number }>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  /** Signs with the treasury key. */
  sign(tx: import("@solana/web3.js").Transaction): void;
  send(raw: Buffer): Promise<void>;
  confirm(signature: string, blockhash: string, lastValidBlockHeight: number): Promise<"confirmed" | "failed" | "timeout">;
  status(signature: string): Promise<null | { confirmed: boolean; err: unknown }>;
  quoteSkr(usdMicro: number): Promise<{ skrMicro: number; priceImpactPct: number }>;
}

export class PayoutError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

/** Reads Jupiter's quote response, refusing anything that isn't a sane integer amount with a small price impact. */
export function parseJupiterQuote(json: unknown): { skrMicro: number; priceImpactPct: number } {
  const j = json as { outAmount?: unknown; priceImpactPct?: unknown; error?: unknown } | null;
  const out = typeof j?.outAmount === "string" && /^\d+$/.test(j.outAmount) ? Number(j.outAmount) : NaN;
  const impact = Number(j?.priceImpactPct ?? 0);
  if (!Number.isSafeInteger(out) || out <= 0) throw new PayoutError("quote_failed", "Couldn't get an SKR price right now.", 502);
  if (!Number.isFinite(impact) || impact > 2) throw new PayoutError("quote_failed", "The SKR price looks unreliable right now (high price impact). Try again shortly.", 502);
  return { skrMicro: out, priceImpactPct: impact };
}

let realChain: PayoutChain | null = null;
export async function getRealChain(): Promise<PayoutChain> {
  if (realChain) return realChain;
  const secret = getServerEnv("SKR_TREASURY_PRIVATE_KEY");
  if (!secret) throw new PayoutError("not_configured", "SKR payouts aren't set up on the server yet.", 503);
  const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
  const { default: bs58 } = await import("bs58");
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  let keypair: InstanceType<typeof Keypair>;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    throw new PayoutError("not_configured", "The treasury key on the server is not valid.", 503);
  }
  const connection = new Connection(solanaRpcUrl(), "confirmed");
  const mint = new PublicKey(SKR_MINT);
  const jupiter = (getServerEnv("JUPITER_API_URL") ?? "https://lite-api.jup.ag").replace(/\/$/, "");

  realChain = {
    treasuryAddress: () => keypair.publicKey.toBase58(),
    async balances() {
      const ata = getAssociatedTokenAddressSync(mint, keypair.publicKey, true);
      const [lamports, token] = await Promise.all([
        connection.getBalance(keypair.publicKey, "confirmed"),
        connection.getTokenAccountBalance(ata, "confirmed").catch(() => null),
      ]);
      return { lamports, skrMicro: BigInt(token?.value.amount ?? "0") };
    },
    latestBlockhash: () => connection.getLatestBlockhash("confirmed"),
    blockHeight: () => connection.getBlockHeight("confirmed"),
    sign: (tx) => tx.sign(keypair),
    async send(raw) {
      await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
    },
    async confirm(signature, blockhash, lastValidBlockHeight) {
      const outcome = await Promise.race([
        connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed").then((r) => (r.value.err ? ("failed" as const) : ("confirmed" as const))),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 45_000)),
      ]).catch(() => "timeout" as const);
      return outcome;
    },
    async status(signature) {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const s = value[0];
      if (!s) return null;
      return { confirmed: s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized", err: s.err };
    },
    async quoteSkr(usdMicro) {
      const url = `${jupiter}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${SKR_MINT}&amount=${usdMicro}&slippageBps=50`;
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
      } catch {
        throw new PayoutError("quote_failed", "Couldn't get an SKR price right now.", 502);
      }
      if (!res.ok) throw new PayoutError("quote_failed", "Couldn't get an SKR price right now.", 502);
      return parseJupiterQuote(await res.json().catch(() => null));
    },
  };
  return realChain;
}

// ── Table access ──────────────────────────────────────────────────────────────

const TABLE: Record<PayoutKind, string> = { shar_claim: "shar_claims", commission: "commission_payouts" };
const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;
const T = (kind: PayoutKind) => sql.raw(TABLE[kind]);

export interface PayoutRow {
  kind: PayoutKind;
  id: string;
  userId: string;
  wallet: string;
  status: string;
  txSignature: string | null;
  lastValidBlockHeight: number | null;
  /** How long since the payout last changed, measured by the database's own clock (immune to timezone parsing). */
  ageMs: number;
  /** Shar claims: the SKR fixed at claim time (micro). Commission: null until an admin prices it. */
  skrMicro: number | null;
  /** Commission only. */
  usdMicro: number | null;
}

export async function loadPayout(kind: PayoutKind, id: string): Promise<PayoutRow | null> {
  const extra = kind === "shar_claim" ? sql`skr_amount as skr_text, null::bigint as usd_micro, null::bigint as skr_micro` : sql`null as skr_text, usd_micro, skr_micro`;
  const [r] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`select id, user_id, wallet, status, tx_signature, last_valid_block_height, (extract(epoch from (now() - updated_at)) * 1000)::bigint as age_ms, ${extra} from ${T(kind)} where id = ${id}::uuid`),
  );
  if (!r) return null;
  const skrMicro = kind === "shar_claim" ? skrToMicro(String(r.skr_text)) : r.skr_micro === null ? null : num(r.skr_micro);
  return {
    kind,
    id: String(r.id),
    userId: String(r.user_id),
    wallet: String(r.wallet),
    status: String(r.status),
    txSignature: (r.tx_signature as string | null) ?? null,
    lastValidBlockHeight: r.last_valid_block_height === null ? null : num(r.last_valid_block_height),
    ageMs: num(r.age_ms),
    skrMicro,
    usdMicro: r.usd_micro === null ? null : num(r.usd_micro),
  };
}

async function setStatus(kind: PayoutKind, id: string, from: string[], to: string, extra: ReturnType<typeof sql>): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`update ${T(kind)} set status = ${to}, ${extra}, updated_at = now() where id = ${id}::uuid and status in (${sql.join(from.map((s) => sql`${s}`), sql`, `)}) returning id`),
  );
  return rows.length > 0;
}

/** Puts a payout back in the queue (only from a state where nothing was, or can ever be, sent). */
async function release(kind: PayoutKind, id: string, note: string): Promise<void> {
  await setStatus(kind, id, ["processing", "sent"], "requested", sql`tx_signature = null, last_valid_block_height = null, note = ${note.slice(0, 300)}`);
}

/** SKR (micro) already sent or paid in the last 24 hours, across both kinds. */
export async function paidLast24h(): Promise<number> {
  const [r] = rowsOf<{ n: string }>(
    await db.execute(sql`
      select (
        coalesce((select sum((skr_amount::numeric * 1000000)::bigint) from shar_claims where status in ('sent', 'paid') and updated_at > now() - interval '24 hours'), 0) +
        coalesce((select sum(skr_micro) from commission_payouts where status in ('sent', 'paid') and updated_at > now() - interval '24 hours'), 0)
      ) as n`),
  );
  return num(r?.n);
}

// ── Pricing a payout (for the admin's review) ─────────────────────────────────

export interface PayoutQuote {
  kind: PayoutKind;
  id: string;
  wallet: string;
  skrMicro: number;
  skr: string;
  usdMicro: number | null;
  usdPerSkr: string | null;
  priceImpactPct: number | null;
  treasury: { address: string; skr: string; sol: string } | null;
  /** Whether this account is linked to others by phone or wallet. Flags must be acknowledged before paying. */
  risk: RiskAssessment;
}

export async function quotePayout(kind: PayoutKind, id: string, chain?: PayoutChain): Promise<PayoutQuote> {
  const c = chain ?? (await getRealChain());
  const row = await loadPayout(kind, id);
  if (!row) throw new PayoutError("not_found", "That payout wasn't found.", 404);
  let skrMicro: number;
  let impact: number | null = null;
  if (kind === "shar_claim") {
    if (row.skrMicro === null) throw new PayoutError("bad_amount", "That claim has an invalid SKR amount.", 500);
    skrMicro = row.skrMicro;
  } else {
    if (row.usdMicro === null) throw new PayoutError("bad_amount", "That payout has no amount.", 500);
    const q = await c.quoteSkr(row.usdMicro);
    skrMicro = q.skrMicro;
    impact = q.priceImpactPct;
  }
  const bal = await c.balances().catch(() => null);
  return {
    kind,
    id,
    wallet: row.wallet,
    skrMicro,
    skr: microToDecimal(skrMicro),
    usdMicro: row.usdMicro,
    usdPerSkr: row.usdMicro ? usdPerSkr(row.usdMicro, skrMicro) : null,
    priceImpactPct: impact,
    treasury: bal ? { address: c.treasuryAddress(), skr: microToDecimal(bal.skrMicro), sol: (bal.lamports / 1e9).toFixed(4) } : null,
    risk: await assessRisk(row.userId, row.wallet),
  };
}

// ── Paying ────────────────────────────────────────────────────────────────────

export type PayResult =
  /** `acknowledged` lists the risk flags the admin confirmed before this was sent (empty when there were none). */
  | { ok: true; status: "paid" | "sent"; signature: string; skrMicro: number; acknowledged: RiskFlag[] }
  | { ok: false; status: number; code: string; error: string; quote?: { skrMicro: number; skr: string }; risk?: RiskAssessment };

const fail = (status: number, code: string, error: string, extra: { quote?: { skrMicro: number; skr: string }; risk?: RiskAssessment } = {}): PayResult => ({ ok: false, status, code, error, ...extra });

/**
 * Pays one payout: builds, signs and sends the SKR transfer. `expectedSkrMicro` is the amount the admin saw and approved
 * (required for commission, which is priced at click time); if the price has moved more than the allowed drift since then,
 * nothing is sent and the admin must review again.
 */
export async function payPayout(input: { kind: PayoutKind; id: string; expectedSkrMicro?: number; acknowledgeRisk?: boolean }, chain?: PayoutChain): Promise<PayResult> {
  const { kind, id } = input;
  let c: PayoutChain;
  try {
    c = chain ?? (await getRealChain());
  } catch (err) {
    if (err instanceof PayoutError) return fail(err.status, err.code, err.message);
    throw err;
  }

  const row = await loadPayout(kind, id);
  if (!row) return fail(404, "not_found", "That payout wasn't found.");
  if (row.status !== "requested") return fail(409, "not_payable", `That payout is already ${row.status}.`);
  if (!isPayableAddress(row.wallet)) return fail(400, "bad_wallet", "That payout's wallet address isn't valid. Reject it.");
  if (kind === "commission" && !(input.expectedSkrMicro && input.expectedSkrMicro > 0)) return fail(400, "quote_required", "Review the SKR price first, then pay.");

  // Accounts linked by phone or wallet: a person has to look, and say so, before money goes out. Checked before the payout is claimed,
  // so a refusal leaves it exactly where it was.
  const risk = await assessRisk(row.userId, row.wallet);
  if (risk.flags.length > 0 && !input.acknowledgeRisk) {
    return fail(409, "risk_unacknowledged", "This account is linked to others by phone or wallet. Review the flags and confirm to pay.", { risk });
  }

  // Claim it: only one caller can move requested -> processing.
  const claimed = await setStatus(kind, id, ["requested"], "processing", sql`note = null`);
  if (!claimed) return fail(409, "not_payable", "Someone else is already paying that one.");

  try {
    // 1. The amount.
    let skrMicro: number;
    if (kind === "shar_claim") {
      if (row.skrMicro === null) throw new PayoutError("bad_amount", "That claim has an invalid SKR amount.", 500);
      skrMicro = row.skrMicro;
    } else {
      const q = await c.quoteSkr(row.usdMicro as number);
      const drift = driftBps(input.expectedSkrMicro as number, q.skrMicro);
      if (drift > PAYMENTS.maxQuoteDriftBps) {
        await release(kind, id, "The SKR price moved while you were reviewing. Review again.");
        return fail(409, "price_moved", `The SKR price moved by ${(drift / 100).toFixed(1)}% since you reviewed it. Review the new amount.`, { quote: { skrMicro: q.skrMicro, skr: microToDecimal(q.skrMicro) } });
      }
      skrMicro = q.skrMicro;
      await db.execute(sql`update commission_payouts set skr_micro = ${skrMicro}, usd_per_skr = ${usdPerSkr(row.usdMicro as number, skrMicro)} where id = ${id}::uuid`);
    }

    // 2. Safety limits.
    if (!(skrMicro > 0)) throw new PayoutError("bad_amount", "The payout amount is zero.", 400);
    if (skrMicro > PAYMENTS.maxPayoutSkr * 1_000_000) throw new PayoutError("too_large", `That's above the ${PAYMENTS.maxPayoutSkr.toLocaleString("en-US")} SKR single-payout limit.`, 400);
    if ((await paidLast24h()) + skrMicro > PAYMENTS.dailyPayoutCapSkr * 1_000_000) throw new PayoutError("daily_cap", "That would go over the 24-hour payout limit. Try again later.", 429);
    const bal = await c.balances();
    if (bal.skrMicro < BigInt(skrMicro)) throw new PayoutError("treasury_low_skr", "The treasury doesn't hold enough SKR for this payout. Top it up.", 409);
    if (bal.lamports < PAYMENTS.minTreasurySol) throw new PayoutError("treasury_low_sol", "The treasury is low on SOL for fees. Top it up.", 409);

    // 3. Build and sign.
    const { PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
    const { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const { default: bs58 } = await import("bs58");
    const mint = new PublicKey(SKR_MINT);
    const treasury = new PublicKey(c.treasuryAddress());
    const owner = new PublicKey(row.wallet);
    if (owner.equals(treasury)) throw new PayoutError("bad_wallet", "A payout can't go to the treasury itself.", 400);
    const from = getAssociatedTokenAddressSync(mint, treasury, true);
    const to = getAssociatedTokenAddressSync(mint, owner, true);
    const { blockhash, lastValidBlockHeight } = await c.latestBlockhash();

    const tx = new Transaction({ feePayer: treasury, blockhash, lastValidBlockHeight });
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(treasury, to, owner, mint),
      createTransferCheckedInstruction(from, mint, to, treasury, BigInt(skrMicro), SKR_DECIMALS),
      new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from(`bluvfi:${kind}:${id}`) }),
    );
    c.sign(tx);
    const sigBytes = tx.signatures[0]?.signature;
    if (!sigBytes) throw new PayoutError("sign_failed", "Couldn't sign the transaction.", 500);
    const signature = bs58.encode(sigBytes);
    const raw = tx.serialize();

    // 4. SAVE the signature BEFORE broadcasting. From here on this payout is never rebuilt until it provably failed.
    const saved = await setStatus(kind, id, ["processing"], "sent", sql`tx_signature = ${signature}, last_valid_block_height = ${lastValidBlockHeight}`);
    if (!saved) return fail(409, "not_payable", "That payout changed while it was being prepared. Nothing was sent.");

    // 5. Broadcast and confirm.
    try {
      await c.send(raw);
    } catch {
      // Unknown whether the network received it, so it STAYS "sent". Reconcile decides once the transaction has expired.
      return fail(502, "send_uncertain", "The transaction may or may not have reached the network. It's marked as sent: press Reconcile in a minute to check.");
    }
    const outcome = await c.confirm(signature, blockhash, lastValidBlockHeight);
    if (outcome === "confirmed") {
      await setStatus(kind, id, ["sent"], "paid", sql`paid_at = now()`);
      return { ok: true, status: "paid", signature, skrMicro, acknowledged: risk.flags };
    }
    if (outcome === "failed") {
      await release(kind, id, "The transaction failed on-chain. Nothing was sent.");
      return fail(502, "tx_failed", "The transaction failed on-chain, so nothing was sent. It's back in the queue.");
    }
    return { ok: true, status: "sent", signature, skrMicro, acknowledged: risk.flags }; // confirmation timed out: still "sent"; Reconcile finishes it
  } catch (err) {
    if (!(err instanceof PayoutError)) console.error("[skr-payout] unexpected error:", kind, id, err instanceof Error ? err.stack ?? err.message : err);
    // Whatever went wrong, ask the database where the payout actually is. Only "processing" means nothing was signed or sent.
    const now = (await loadPayout(kind, id).catch(() => null))?.status;
    if (now === "processing") {
      const message = err instanceof PayoutError ? err.message : "Something went wrong before sending. Nothing was sent.";
      await release(kind, id, message);
      return fail(err instanceof PayoutError ? err.status : 500, err instanceof PayoutError ? err.code : "internal", message);
    }
    if (now === "sent" || now === "paid") {
      // The transaction was signed (and may have been broadcast) before the failure. Never claim nothing was sent.
      return fail(500, "record_failed", "The payment may have been sent, but recording it failed. DON'T pay again: press Reconcile to check what happened.");
    }
    return fail(500, "internal", "Something went wrong. Check the payout's status before doing anything else.");
  }
}

// ── Reconciling a payout that is not finished ─────────────────────────────────

export type ReconcileResult =
  | { ok: true; outcome: "paid" | "released" | "pending" | "unchanged"; message: string }
  | { ok: false; status: number; error: string };

/** Settles a stuck "sent" or "processing" payout from what the chain says, never guessing. Safe to run any number of times. */
export async function reconcilePayout(kind: PayoutKind, id: string, chain?: PayoutChain): Promise<ReconcileResult> {
  let c: PayoutChain;
  try {
    c = chain ?? (await getRealChain());
  } catch (err) {
    if (err instanceof PayoutError) return { ok: false, status: err.status, error: err.message };
    throw err;
  }
  const row = await loadPayout(kind, id);
  if (!row) return { ok: false, status: 404, error: "That payout wasn't found." };

  if (row.status === "processing") {
    if (row.ageMs < PAYMENTS.processingStaleMs) return { ok: true, outcome: "pending", message: "It's being prepared right now." };
    await release(kind, id, "Released: it was stuck before anything was sent.");
    return { ok: true, outcome: "released", message: "It was stuck before anything was sent, so it's back in the queue." };
  }
  if (row.status !== "sent" || !row.txSignature) return { ok: true, outcome: "unchanged", message: `Nothing to reconcile: it's ${row.status}.` };

  const st = await c.status(row.txSignature).catch(() => null);
  if (st && st.err) {
    await release(kind, id, "The transaction failed on-chain. Nothing was sent.");
    return { ok: true, outcome: "released", message: "The transaction failed on-chain, so nothing was sent. It's back in the queue." };
  }
  if (st && st.confirmed) {
    await setStatus(kind, id, ["sent"], "paid", sql`paid_at = now()`);
    return { ok: true, outcome: "paid", message: "The transaction landed. Marked as paid." };
  }
  // Not seen. It's only safe to retry once the chain is past the last block the transaction could land in.
  const height = await c.blockHeight().catch(() => null);
  if (height !== null && row.lastValidBlockHeight !== null && height > row.lastValidBlockHeight) {
    // One last look, in case it landed right at the end.
    const again = await c.status(row.txSignature).catch(() => null);
    if (again && !again.err && again.confirmed) {
      await setStatus(kind, id, ["sent"], "paid", sql`paid_at = now()`);
      return { ok: true, outcome: "paid", message: "The transaction landed. Marked as paid." };
    }
    await release(kind, id, "The transaction expired without landing. Nothing was sent.");
    return { ok: true, outcome: "released", message: "The transaction expired and can never land, so nothing was sent. It's back in the queue." };
  }
  return { ok: true, outcome: "pending", message: "Still waiting: the transaction can still land. Check again in a minute." };
}

// ── Rejecting ─────────────────────────────────────────────────────────────────

/** Declines a waiting payout. Shar claims give the Shar back automatically; commission goes back to the owner's balance. */
export async function rejectPayout(kind: PayoutKind, id: string, note: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const clean = note.trim().slice(0, 300) || "Declined";
  if (kind === "shar_claim") {
    const done = await setStatus("shar_claim", id, ["requested"], "rejected", sql`note = ${clean}`);
    return done ? { ok: true } : { ok: false, status: 409, error: "Only a waiting claim can be rejected." };
  }
  const rows = rowsOf<{ user_id: string }>(
    await db.execute(sql`
      with rej as (
        update commission_payouts set status = 'rejected', note = ${clean}, updated_at = now()
        where id = ${id}::uuid and status = 'requested' returning user_id, usd_micro
      ), back as (
        insert into earnings_balances (user_id, available_micro, lifetime_micro)
        select user_id, usd_micro, 0 from rej
        on conflict (user_id) do update set available_micro = earnings_balances.available_micro + excluded.available_micro, updated_at = now()
        returning 1
      )
      select user_id from rej`),
  );
  return rows.length > 0 ? { ok: true } : { ok: false, status: 409, error: "Only a waiting withdrawal can be rejected." };
}
