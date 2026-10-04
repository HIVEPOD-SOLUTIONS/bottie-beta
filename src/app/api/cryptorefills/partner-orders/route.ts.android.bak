import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import {
  validatePartnerOrder,
  createPartnerOrder,
  listPaymentMethods,
  describeCryptorefillsError,
  maxOrderUsd,
  CryptorefillsError,
  type CrPartnerRequest,
  type CrEndUser,
} from "@/lib/cryptorefills";

/**
 * POST /api/cryptorefills/partner-orders — pay with any supported coin.
 *
 *   { action: "validate", order }  → { coin_amount, coin }   dry run, creates nothing
 *   { action: "create", order, priceUsd, productName }
 *                                  → { order }  deposit address + exact amount
 *
 * `order` = { email, brand_name, country_code, denomination, product_value?, beneficiary_account, coin, network }
 * Cryptorefills treats unpaid orders as abuse of the partner key, so the UI
 * validates first and only creates when the user taps "Get payment address".
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parse(raw: unknown): CrPartnerRequest | string {
  const o = raw as Partial<CrPartnerRequest> | null;
  if (!o || typeof o.email !== "string" || !EMAIL_RE.test(o.email)) return "A valid email is required";
  for (const k of ["brand_name", "country_code", "denomination", "beneficiary_account", "coin", "network"] as const) {
    if (typeof o[k] !== "string" || !o[k]!.trim() || o[k]!.length > 120) return `${k} is required`;
  }
  if (!/^[a-zA-Z]{2}$/.test(o.country_code!)) return "country_code must be a 2-letter code";
  if (o.denomination === "range" && !(typeof o.product_value === "number" && o.product_value > 0)) return "product_value is required for a custom amount";
  return {
    email: o.email.trim(),
    brand_name: o.brand_name!.trim(),
    country_code: o.country_code!.toUpperCase(),
    denomination: o.denomination!.trim(),
    ...(o.denomination === "range" ? { product_value: o.product_value } : {}),
    beneficiary_account: o.beneficiary_account!.trim(),
    coin: o.coin!.trim(),
    network: o.network!.trim(),
  };
}

function endUser(req: Request): CrEndUser {
  return {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "0.0.0.0",
    userAgent: req.headers.get("user-agent") ?? "Bluvfi",
  };
}

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  let body: { action?: string; order?: unknown; priceUsd?: number; productName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const order = parse(body.order);
  if (typeof order === "string") return NextResponse.json({ error: order }, { status: 400 });

  try {
    // Only coins/networks Cryptorefills currently lists for wallet payments.
    const methods = await listPaymentMethods();
    if (!methods.some((m) => m.coin === order.coin && m.network === order.network)) {
      return NextResponse.json({ error: "That coin or network isn't available right now. Pick another." }, { status: 400 });
    }

    if (body.action === "validate") {
      return NextResponse.json(await validatePartnerOrder(order, endUser(req)));
    }

    if (body.action === "create") {
      const priceUsd = Number(body.priceUsd);
      if (!(priceUsd > 0)) return NextResponse.json({ error: "priceUsd is required" }, { status: 400 });
      if (priceUsd > maxOrderUsd()) {
        return NextResponse.json({ error: `This order is above the $${maxOrderUsd()} single-order limit.` }, { status: 400 });
      }
      const created = await createPartnerOrder(order, endUser(req));
      // Pending until the user's deposit arrives; the [id] route flips it. Also proves ownership there.
      await db.insert(payments).values({
        userId,
        type: "bill",
        referenceId: created.order_id,
        description: `Purchased ${(body.productName ?? order.brand_name).slice(0, 120)} via Cryptorefills (${order.coin} on ${order.network})`,
        amountUsdc: priceUsd.toFixed(6),
        status: "pending",
        chain: order.network,
      });
      return NextResponse.json({ order: created });
    }

    return NextResponse.json({ error: 'action must be "validate" or "create"' }, { status: 400 });
  } catch (err) {
    console.error("[cryptorefills/partner-orders]", err instanceof Error ? err.message : err);
    const status = err instanceof CryptorefillsError && err.httpStatus < 500 ? err.httpStatus : 502;
    return NextResponse.json({ error: describeCryptorefillsError(err) }, { status });
  }
}
