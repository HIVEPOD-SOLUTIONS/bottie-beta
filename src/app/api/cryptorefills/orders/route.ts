import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import {
  createOrderPhase1,
  createOrderPhase2,
  describeCryptorefillsError,
  CryptorefillsError,
  BASE_NETWORK,
  SOLANA_NETWORK,
  type CrOrderRequest,
  type CrRail,
} from "@/lib/cryptorefills";

/**
 * POST /api/cryptorefills/orders
 *
 * Two-step x402 checkout, proxied so both phases hit the same Cryptorefills
 * host and the 402 is verified server-side before the user signs anything.
 *
 *   { phase: "quote", order, rail }
 *     → { rail, sessionId, requirement, expiresAt }   (Phase 1 — creates an unpaid order upstream)
 *   { phase: "pay", order, rail, sessionId, paymentSignature, productName }
 *     → { order }                                (Phase 2 — settles and records the payment)
 *
 * `order` = { email, items: [{ beneficiary_account, product_id | brand_name+denomination+country_code, product_value? }] }
 * `rail` = "base" (default) | "solana" — both gasless USDC.
 * `paymentSignature` = base64url PAYMENT-SIGNATURE: an EIP-3009 signature (Base) or a
 * partially-signed v0 transaction (Solana).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseOrder(raw: unknown): CrOrderRequest | string {
  const o = raw as Partial<CrOrderRequest> | null;
  if (!o || typeof o.email !== "string" || !EMAIL_RE.test(o.email)) return "A valid email is required";
  if (!Array.isArray(o.items) || o.items.length !== 1) return "Exactly one item is required";
  const it = o.items[0];
  if (!it || typeof it.beneficiary_account !== "string" || !it.beneficiary_account.trim()) return "A recipient is required";
  const byId = typeof it.product_id === "string" && it.product_id.length > 0;
  const byTriple = typeof it.brand_name === "string" && typeof it.denomination === "string" && typeof it.country_code === "string";
  if (byId === byTriple) return "Address the product by product_id or by brand_name + denomination + country_code";
  if (it.product_value !== undefined && !(typeof it.product_value === "number" && it.product_value > 0)) return "Invalid product_value";

  // Rebuild with only known fields so nothing else reaches Cryptorefills.
  return {
    email: o.email.trim(),
    items: [{
      beneficiary_account: it.beneficiary_account.trim(),
      ...(byId
        ? { product_id: it.product_id }
        : { brand_name: it.brand_name, denomination: it.denomination, country_code: it.country_code!.toLowerCase() }),
      ...(it.product_value !== undefined ? { product_value: it.product_value } : {}),
    }],
  };
}

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGYPxQpKZmCVE24A8vzrsv7";

/**
 * Reads the signed USDC amount back out of PAYMENT-SIGNATURE so the recorded
 * spend matches what the user signed. Base: the EIP-3009 `value`. Solana: the
 * TransferChecked (tag 12) amount inside the partially-signed transaction.
 */
async function signedAmountUsdc(paymentSignature: string, rail: CrRail): Promise<string | null> {
  try {
    const decoded = JSON.parse(Buffer.from(paymentSignature, "base64url").toString("utf8")) as {
      network?: string;
      payload?: { authorization?: { value?: string }; transaction?: string };
    };
    if (rail === "base") {
      const value = decoded.payload?.authorization?.value;
      if (decoded.network !== BASE_NETWORK || !value || !/^\d+$/.test(value)) return null;
      return (Number(value) / 1e6).toFixed(6);
    }
    const txB64 = decoded.payload?.transaction;
    if (decoded.network !== SOLANA_NETWORK || !txB64) return null;
    const { VersionedTransaction } = await import("@solana/web3.js");
    const tx = VersionedTransaction.deserialize(Buffer.from(txB64, "base64"));
    const keys = tx.message.staticAccountKeys;
    const transfer = tx.message.compiledInstructions.find(
      (ix) => keys[ix.programIdIndex]?.toBase58() === SPL_TOKEN_PROGRAM && ix.data[0] === 12,
    );
    if (!transfer || transfer.data.length < 9) return null;
    const amount = Buffer.from(transfer.data).readBigUInt64LE(1);
    return (Number(amount) / 1e6).toFixed(6);
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  let body: { phase?: string; order?: unknown; rail?: string; sessionId?: string; paymentSignature?: string; productName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const order = parseOrder(body.order);
  if (typeof order === "string") return NextResponse.json({ error: order }, { status: 400 });
  const rail: CrRail = body.rail === "solana" ? "solana" : "base";

  if (body.phase === "quote") {
    try {
      return NextResponse.json(await createOrderPhase1(order, rail));
    } catch (err) {
      console.error("[cryptorefills/orders] phase 1:", err instanceof Error ? err.message : err);
      const status = err instanceof CryptorefillsError && err.httpStatus < 500 ? err.httpStatus : 502;
      return NextResponse.json({ error: describeCryptorefillsError(err) }, { status });
    }
  }

  if (body.phase === "pay") {
    const { sessionId, paymentSignature } = body;
    if (!sessionId || !paymentSignature || paymentSignature.length > 4096) {
      return NextResponse.json({ error: "sessionId and paymentSignature are required" }, { status: 400 });
    }
    const amountUsdc = await signedAmountUsdc(paymentSignature, rail);
    if (!amountUsdc) return NextResponse.json({ error: "Invalid payment signature" }, { status: 400 });

    try {
      const result = await createOrderPhase2(order, paymentSignature, sessionId, rail);
      const productName = (body.productName ?? "digital product").slice(0, 120);
      // The row also proves ownership for GET /api/cryptorefills/orders/[id].
      await db.insert(payments).values({
        userId,
        type: "bill",
        referenceId: result.order_id,
        description: `Purchased ${productName} via Cryptorefills (USDC on ${rail === "solana" ? "Solana" : "Base"})`,
        amountUsdc,
        status: result.status === "completed" ? "completed" : "pending",
        chain: rail === "solana" ? "solana" : "evm",
      });
      return NextResponse.json({ order: result });
    } catch (err) {
      console.error("[cryptorefills/orders] phase 2:", err instanceof Error ? err.message : err);
      if (err instanceof CryptorefillsError) {
        // 503: facilitator unreachable, nothing was charged, the same signature may be retried.
        return NextResponse.json(
          { error: describeCryptorefillsError(err), retryable: err.httpStatus === 503 },
          { status: err.httpStatus === 503 ? 503 : err.httpStatus === 402 ? 402 : err.httpStatus < 500 ? err.httpStatus : 502 },
        );
      }
      return NextResponse.json({ error: describeCryptorefillsError(err) }, { status: 502 });
    }
  }

  return NextResponse.json({ error: 'phase must be "quote" or "pay"' }, { status: 400 });
}
