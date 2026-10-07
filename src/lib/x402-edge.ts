import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { providerListings } from "@/lib/db/schema";
import { isValidPriceMicro, microToDecimal, splitPrice, usdToMicro } from "@/lib/payments-rules";
import type { GatewayResult } from "@/lib/provider-network";
import {
  X402,
  X402_NETWORKS,
  X402_VERSION,
  buildPaymentRequired,
  buildRequirements,
  decodePaymentHeader,
  encodeHeader,
  paymentHash,
  requirementsMatch,
  x402Caller,
  type PaymentPayload,
  type PaymentRequirements,
  type X402Config,
} from "@/lib/x402-rules";

/**
 * x402 edge: an outside agent pays for ONE call to a paid provider with a wallet, no Bluvfi account needed.
 *
 *   verify  ->  call the provider  ->  settle  ->  answer
 *
 * The payment is verified first, the provider is called, and the money is only moved (settled) once the provider has answered
 * successfully. So a failing provider never costs the agent anything, and the agent never gets an answer it hasn't paid for:
 * the answer is withheld unless settlement succeeds. Bluvfi is the merchant: the money lands in Bluvfi's wallet and the owner earns
 * 80% as commission, the same as a credits call.
 *
 * Every state change is a compare-and-set on the receipt row, and the money bookkeeping (usage row, owner commission,
 * signature claim) is ONE SQL statement, so a payment is counted exactly once even if the same request arrives twice or the
 * process dies half-way. The only state that needs a human is "settling": we asked the facilitator to move the money and never
 * learned the answer. Such a receipt is never retried automatically and shows up in the admin queue.
 *
 * x402 callers have no Bluvfi account, so they earn the owner no Shar: only commission. (Anyone can make a wallet; Shar is for
 * real people.)
 */

type Listing = typeof providerListings.$inferSelect;
const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── The facilitator ───────────────────────────────────────────────────────────

export type VerifyOutcome = { kind: "valid"; payer: string } | { kind: "invalid"; reason: string } | { kind: "error" };
/** "unknown" means we asked for the money to move and don't know whether it did. */
export type SettleOutcome = { kind: "ok"; transaction: string; payer: string | null } | { kind: "failed"; reason: string } | { kind: "unknown" };

export interface Facilitator {
  feePayer(cfg: X402Config): Promise<string | null>;
  verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyOutcome>;
  settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleOutcome>;
}

const FEE_PAYER_TTL_MS = 10 * 60_000;
let feePayerCache: { key: string; value: string; at: number } | null = null;

async function readJson(res: Response): Promise<unknown> {
  const text = (await res.text()).slice(0, 50_000);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Talks to any x402 facilitator over HTTP (POST /verify, POST /settle, GET /supported). */
export function httpFacilitator(cfg: X402Config): Facilitator {
  const base = cfg.facilitatorUrl;
  const post = (path: string, payment: PaymentPayload, requirements: PaymentRequirements, timeoutMs: number) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirements }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
      cache: "no-store",
    });

  return {
    async feePayer(c) {
      if (c.feePayer) return c.feePayer;
      const key = `${base}|${c.network}`;
      if (feePayerCache && feePayerCache.key === key && Date.now() - feePayerCache.at < FEE_PAYER_TTL_MS) return feePayerCache.value;
      try {
        const res = await fetch(`${base}/supported`, { signal: AbortSignal.timeout(8_000), redirect: "error", cache: "no-store" });
        if (!res.ok) return null;
        const data = await readJson(res);
        const caip2 = X402_NETWORKS[c.network].caip2;
        const kinds = isObject(data) && Array.isArray(data.kinds) ? data.kinds : [];
        const kind = kinds.find((k) => isObject(k) && k.scheme === "exact" && k.network === caip2 && k.x402Version === X402_VERSION)
          ?? kinds.find((k) => isObject(k) && k.scheme === "exact" && k.network === caip2);
        const fee = isObject(kind) && isObject(kind.extra) ? kind.extra.feePayer : undefined;
        if (typeof fee !== "string" || !ADDRESS.test(fee)) return null;
        feePayerCache = { key, value: fee, at: Date.now() };
        return fee;
      } catch {
        return null;
      }
    },

    async verify(payment, requirements) {
      try {
        const res = await post("/verify", payment, requirements, 10_000);
        const data = await readJson(res);
        if (!isObject(data) || typeof data.isValid !== "boolean") return { kind: "error" };
        if (data.isValid) return { kind: "valid", payer: typeof data.payer === "string" && data.payer ? data.payer : "unknown" };
        return { kind: "invalid", reason: typeof data.invalidReason === "string" ? data.invalidReason.slice(0, 80) : "invalid_payment" };
      } catch {
        return { kind: "error" };
      }
    },

    async settle(payment, requirements) {
      try {
        const res = await post("/settle", payment, requirements, 30_000);
        const data = await readJson(res);
        if (!isObject(data) || typeof data.success !== "boolean") return { kind: "unknown" };
        if (data.success === false) return { kind: "failed", reason: typeof data.errorReason === "string" ? data.errorReason.slice(0, 80) : "settlement_failed" };
        if (typeof data.transaction !== "string" || !SIGNATURE.test(data.transaction)) return { kind: "unknown" };
        return { kind: "ok", transaction: data.transaction, payer: typeof data.payer === "string" ? data.payer : null };
      } catch {
        return { kind: "unknown" }; // timeout or dropped connection after sending: the money may have moved
      }
    },
  };
}

// ── Receipts (every step is a compare-and-set) ────────────────────────────────

/** Starts a receipt. Returns its id, or the status of the one that already exists for this payment. */
async function claimReceipt(listingId: string, hash: string, micro: number): Promise<{ id: string } | { existing: string | null }> {
  const staleSecs = Math.floor(X402.staleMs / 1000);
  const [row] = rowsOf<{ id: string }>(
    await db.execute(sql`
      insert into x402_receipts (listing_id, payload_hash, amount_micro, status)
      values (${listingId}::uuid, ${hash}, ${micro}, 'verifying')
      on conflict (payload_hash) do update set status = 'verifying', error = null, updated_at = now()
        where x402_receipts.listing_id = excluded.listing_id
          and (x402_receipts.status = 'failed'
            or (x402_receipts.status in ('verifying', 'calling') and x402_receipts.updated_at < now() - make_interval(secs => ${staleSecs})))
      returning id`),
  );
  if (row) return { id: row.id };
  const [cur] = rowsOf<{ status: string }>(await db.execute(sql`select status from x402_receipts where payload_hash = ${hash}`));
  return { existing: cur?.status ?? null };
}

async function advance(id: string, from: string[], to: string, extra: { payer?: string; error?: string } = {}): Promise<boolean> {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      update x402_receipts
      set status = ${to}, payer = coalesce(${extra.payer ?? null}::text, payer), error = ${extra.error ?? null}::text, updated_at = now()
      where id = ${id}::uuid and status in (${sql.join(from.map((f) => sql`${f}`), sql`, `)})
      returning id`),
  );
  return rows.length > 0;
}

/**
 * The money bookkeeping for a settled payment, in ONE statement: claim the signature, mark the receipt settled, write the usage
 * row and credit the owner's commission. All of it happens or none of it does, and only once per receipt.
 */
async function recordSettled(receiptId: string, listing: Listing, payer: string, signature: string, priceMicro: number): Promise<boolean> {
  const split = splitPrice(priceMicro);
  const [r] = rowsOf<{ settled: string }>(
    await db.execute(sql`
      with claim as (
        insert into signature_claims (signature, kind) values (${signature}, 'x402') on conflict do nothing returning signature
      ), r as (
        update x402_receipts set status = 'settled', signature = ${signature}, payer = ${payer}, updated_at = now()
        where id = ${receiptId}::uuid and status = 'settling' and exists (select 1 from claim)
        returning listing_id
      ), u as (
        insert into provider_usage (listing_id, caller_user_id, amount_usdc, shar, settlement_ref, paid_micro, owner_micro, platform_micro)
        select listing_id, ${x402Caller(payer)}, ${microToDecimal(priceMicro)}, 0, ${signature}, ${priceMicro}, ${split.owner}, ${split.platform} from r
        returning owner_micro
      ), e as (
        insert into earnings_balances (user_id, available_micro, lifetime_micro)
        select ${listing.ownerUserId}, owner_micro, owner_micro from u
        on conflict (user_id) do update
          set available_micro = earnings_balances.available_micro + excluded.available_micro,
              lifetime_micro = earnings_balances.lifetime_micro + excluded.lifetime_micro,
              updated_at = now()
        returning 1
      )
      select (select count(*) from r) as settled`),
  );
  return num(r?.settled) > 0;
}

/** Payments we asked the facilitator to settle and never heard back about. An admin checks each on-chain. */
export async function listStuckX402() {
  const cutoff = Math.floor(X402.stuckMs / 1000);
  return rowsOf<{ id: string; listing_id: string; name: string | null; payer: string | null; amount_micro: string; updated_at: string }>(
    await db.execute(sql`
      select r.id, r.listing_id, l.name, r.payer, r.amount_micro, r.updated_at
      from x402_receipts r left join provider_listings l on l.id = r.listing_id
      where r.status = 'settling' and r.updated_at < now() - make_interval(secs => ${cutoff})
      order by r.updated_at asc limit 50`),
  ).map((r) => ({ id: r.id, listingId: r.listing_id, listing: r.name, payer: r.payer, amountMicro: num(r.amount_micro), since: new Date(r.updated_at).toISOString() }));
}

// ── One paid call ─────────────────────────────────────────────────────────────

export interface X402Input {
  listing: Listing;
  /** The URL the agent called, echoed back in the payment request. */
  url: string;
  paymentHeader: string | null;
  payload: unknown;
}
export interface X402Result {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export interface X402Deps {
  config: X402Config | null;
  facilitator: Facilitator;
  callProvider: (listing: Listing, payload: unknown) => Promise<GatewayResult>;
}

const NO_STORE = { "Cache-Control": "no-store" };
const json = (status: number, body: unknown, headers: Record<string, string> = {}): X402Result => ({ status, headers: { ...NO_STORE, ...headers }, body });

export async function handleX402Call(input: X402Input, deps: X402Deps): Promise<X402Result> {
  const { listing } = input;
  const { facilitator, config: cfg } = deps;
  if (!cfg) return json(503, { error: "Paying with x402 isn't switched on yet." });

  const priceMicro = usdToMicro(listing.priceUsdc);
  if (priceMicro === null || !isValidPriceMicro(priceMicro)) return json(500, { error: "This provider's price is invalid." });
  if (priceMicro === 0) return json(400, { error: "This provider is free. Call it from the Bluvfi app instead." });

  const feePayer = await facilitator.feePayer(cfg);
  if (!feePayer) return json(502, { error: "The payment service isn't reachable right now. Try again in a moment." });
  const requirements = buildRequirements(cfg, priceMicro, feePayer);
  const askFor = (error?: string) => {
    const required = buildPaymentRequired(input.url, `One call to ${listing.name}`, requirements, error);
    return json(402, required, { "PAYMENT-REQUIRED": encodeHeader(required) });
  };

  if (!input.paymentHeader) return askFor();
  const decoded = decodePaymentHeader(input.paymentHeader);
  if (!decoded.ok) return askFor(decoded.error);
  const payment = decoded.payment;
  if (!requirementsMatch(payment.accepted, requirements)) return askFor("payment_requirements_mismatch");

  const claimed = await claimReceipt(listing.id, paymentHash(payment), priceMicro);
  if ("existing" in claimed) {
    const inFlight = claimed.existing === "settling";
    return json(409, {
      error: inFlight ? "payment_in_progress" : claimed.existing === "settled" ? "payment_already_used" : "payment_in_use",
      message: inFlight
        ? "This payment was sent to be settled and we're still confirming it. Don't pay again; check back shortly."
        : "This payment has already been used. Sign a new one.",
    });
  }
  const receiptId = claimed.id;

  // 1. Verify
  const verified = await facilitator.verify(payment, requirements);
  if (verified.kind === "error") {
    await advance(receiptId, ["verifying"], "failed", { error: "verify_unreachable" });
    return json(502, { error: "The payment service isn't reachable right now. You weren't charged.", charged: false });
  }
  if (verified.kind === "invalid") {
    await advance(receiptId, ["verifying"], "failed", { error: verified.reason });
    return askFor(verified.reason);
  }
  if (!(await advance(receiptId, ["verifying"], "calling", { payer: verified.payer }))) {
    return json(409, { error: "payment_in_use", message: "This payment is being handled by another request." });
  }

  // 2. Call the provider. Nothing has moved yet, so a failure here costs the agent nothing.
  let res: GatewayResult;
  try {
    res = await deps.callProvider(listing, input.payload);
  } catch {
    res = { ok: false, status: 502, error: "The provider didn't answer." };
  }
  if (!res.ok || res.status < 200 || res.status >= 300) {
    const reason = res.ok ? `The provider answered with an error (${res.status}).` : res.error;
    await advance(receiptId, ["calling"], "failed", { error: "provider_failed" });
    return json(res.ok ? 502 : res.status, { error: `${reason} You weren't charged.`, charged: false });
  }

  // 3. Settle. From here on the money may move, so nothing is retried automatically.
  if (!(await advance(receiptId, ["calling"], "settling"))) {
    return json(409, { error: "payment_in_use", message: "This payment is being handled by another request." });
  }
  const settled = await facilitator.settle(payment, requirements);
  if (settled.kind === "failed") {
    await advance(receiptId, ["settling"], "failed", { error: settled.reason });
    return askFor(`settlement_failed: ${settled.reason}`);
  }
  if (settled.kind === "unknown") {
    console.error("[x402] STUCK: settlement outcome unknown", { receiptId, listingId: listing.id, payer: verified.payer, amountMicro: priceMicro });
    return json(504, { error: "payment_pending", message: "We couldn't confirm your payment yet, so the answer is held back. Don't pay again; contact support with this receipt.", receipt: receiptId });
  }

  // The agent has paid. Record it; if recording fails the answer is still delivered and the receipt is left for an admin.
  const payer = settled.payer ?? verified.payer;
  let recorded = false;
  try {
    recorded = await recordSettled(receiptId, listing, payer, settled.transaction, priceMicro);
  } catch (err) {
    console.error("[x402] STUCK: settled but not recorded", { receiptId, signature: settled.transaction, error: err instanceof Error ? err.message : err });
  }
  if (!recorded) console.error("[x402] STUCK: settled but not recorded", { receiptId, signature: settled.transaction });

  return json(
    200,
    { providerStatus: res.status, data: res.body, paidMicro: priceMicro, paid: microToDecimal(priceMicro), signature: settled.transaction },
    { "PAYMENT-RESPONSE": encodeHeader({ success: true, transaction: settled.transaction, network: requirements.network, payer }) },
  );
}
