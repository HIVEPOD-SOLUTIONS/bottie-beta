import { tool } from "ai";
import { z } from "zod";
import { and, desc, eq, like } from "drizzle-orm";
import { parsePhoneNumberWithError, type CountryCode } from "libphonenumber-js";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import {
  listBrands,
  listCatalog,
  quotePrice,
  getOrder,
  getPartnerOrder,
  listPaymentMethods,
  partnerConfigured,
  maxOrderUsd,
  describeCryptorefillsError,
  type CrOrderRequest,
  type CrPartnerRequest,
} from "@/lib/cryptorefills";
import { kindOf, cardCategoryOf, dedupeBrands } from "@/lib/cryptorefills-categories";

/**
 * AI agent tools for Cryptorefills — the same catalogue, filters and payment
 * options as Bills → Browse → Cryptorefills.
 *
 *   search_cryptorefills               brands in a country, by section, gift-card category and keyword
 *   get_cryptorefills_products         amounts + USDC prices for a brand
 *   get_cryptorefills_payment_methods  coins/networks for "other crypto" (if enabled)
 *   buy_cryptorefills_product          prices the order and hands it to a payment card in the
 *                                      chat. Nothing is created upstream or charged until the
 *                                      user confirms there.
 *   get_cryptorefills_order            status of one of the user's own orders
 *   get_cryptorefills_orders           the user's Cryptorefills purchase history
 */

const countrySchema = z.string().regex(/^[a-zA-Z]{2}$/).describe("ISO 3166-1 alpha-2 country code, e.g. 'US', 'NG', 'GB'");

// Gasless x402 rows store chain "evm"/"solana"; deposit-address (partner) rows store the network name.
const isGaslessChain = (chain: string | null) => chain === "evm" || chain === "solana";

export function createCryptorefillsTools(userId?: string) {
  return {
    search_cryptorefills: tool({
      description:
        "Search Cryptorefills for gift cards, mobile phone refills (airtime/data) or travel eSIMs sold in a country. " +
        "Same catalogue and filters as the app's Cryptorefills screen. Use when the user asks for Cryptorefills, " +
        "or Bitrefill doesn't have what they want. Then call get_cryptorefills_products with an exact brand_name.",
      inputSchema: z.object({
        country: countrySchema,
        kind: z.enum(["cards", "topup", "esim"]).describe("cards = gift cards, topup = phone airtime/data, esim = travel eSIM data"),
        category: z.enum(["entertainment", "gaming", "shopping", "food", "vpn", "travel"]).optional()
          .describe("Gift-card category (kind=cards only). vpn = privacy (VPNs, password managers)."),
        query: z.string().max(60).optional().describe("Brand or carrier keyword, e.g. 'netflix', 'mtn', 'amazon'"),
      }),
      execute: async ({ country, kind, category, query }) => {
        try {
          const q = query?.trim().toLowerCase();
          const matches = dedupeBrands(await listBrands(country)).filter((b) =>
            kindOf(b.category) === kind &&
            (kind !== "cards" || !category || cardCategoryOf(b) === category) &&
            (!q || b.brand_name.toLowerCase().includes(q) || b.category.includes(q)),
          );
          return {
            country: country.toUpperCase(),
            total: matches.length,
            brands: matches.slice(0, 25).map((b) => ({
              brand_name: b.brand_name,
              category: kind === "cards" ? cardCategoryOf(b) ?? b.category : b.category,
              min: b.min,
              max: b.max,
            })),
            tip: matches.length
              ? "Call get_cryptorefills_products(country, brand_name) with the exact brand_name to see amounts and prices."
              : `Nothing matched in ${country.toUpperCase()}${category ? ` under ${category}` : ""}. Try without the category, a broader query, or another country.`,
          };
        } catch (err) {
          return { error: describeCryptorefillsError(err) };
        }
      },
    }),

    get_cryptorefills_products: tool({
      description:
        "List the amounts available for one Cryptorefills brand in a country, with USDC prices. " +
        "Fixed products have a product_id and price_usdc. Range products (is_range=true) let the user pick any amount " +
        "between min_value and max_value in the product's local currency; buy_cryptorefills_product quotes the USDC price.",
      inputSchema: z.object({
        country: countrySchema,
        brand: z.string().min(1).max(120).describe("Exact brand_name from search_cryptorefills, e.g. 'Netflix', 'MTN Data'"),
      }),
      execute: async ({ country, brand }) => {
        try {
          const items = await listCatalog(country, brand);
          return {
            brand,
            products: items.slice(0, 40).map((it) => ({
              product_id: it.product_id,
              name: it.product_name,
              label: it.is_range ? `Custom amount ${it.min_value}–${it.max_value} ${it.currency ?? ""}`.trim() : it.denomination_label ?? it.denomination,
              is_range: it.is_range,
              currency: it.currency,
              price_usdc: it.is_range ? null : it.price_usdc,
              min_value: it.min_value,
              max_value: it.max_value,
            })),
            tip: items.length
              ? "Confirm the amount with the user and collect their delivery email (and phone number for top-ups), then call buy_cryptorefills_product."
              : "No products for this brand right now. Suggest another brand.",
          };
        } catch (err) {
          return { error: describeCryptorefillsError(err) };
        }
      },
    }),

    get_cryptorefills_payment_methods: tool({
      description:
        "List the coins and networks a user can pay Cryptorefills with besides gasless USDC (e.g. USDT on Tron, BTC, ETH, TON). " +
        "These use a deposit address and the user pays the network fee. Call before buy_cryptorefills_product with payWith='other'.",
      inputSchema: z.object({
        coin: z.string().max(12).optional().describe("Filter to one coin, e.g. 'USDT'"),
      }),
      execute: async ({ coin }) => {
        if (!partnerConfigured()) {
          return { enabled: false, tip: "Only gasless USDC (Base or Solana) is available on this server. Offer that instead." };
        }
        try {
          const all = await listPaymentMethods();
          const list = coin ? all.filter((m) => m.coin.toLowerCase() === coin.toLowerCase()) : all;
          const byCoin: Record<string, string[]> = {};
          for (const m of list) (byCoin[m.coin] ??= []).push(m.network);
          return {
            enabled: true,
            gasless: ["USDC on Base", "USDC on Solana"],
            other: byCoin,
            tip: "Pass coin and the exact network string to buy_cryptorefills_product with payWith='other'. The user pays network gas on these.",
          };
        } catch (err) {
          return { error: describeCryptorefillsError(err) };
        }
      },
    }),

    buy_cryptorefills_product: tool({
      description:
        "Prepare a Cryptorefills purchase and show the user a payment card to confirm. " +
        "payWith='base' (default) or 'solana': gasless USDC — the card has the user sign once, waits for delivery and shows the code. " +
        "payWith='other': any coin from get_cryptorefills_payment_methods — the card shows a deposit address and amount to send. " +
        "Only call this after the user has confirmed the product, amount, delivery email, and how they want to pay. For phone refills also pass the phone number.",
      inputSchema: z.object({
        country: countrySchema,
        brand: z.string().min(1).max(120).describe("Exact brand_name"),
        productId: z.string().min(1).max(64).describe("product_id from get_cryptorefills_products"),
        productValue: z.number().positive().optional().describe("Required for range products: amount in the product's local currency"),
        email: z.string().email().describe("Email that receives the code or receipt"),
        phone: z.string().max(32).optional().describe("Phone number to top up (required for phone refills). Local or international format."),
        payWith: z.enum(["base", "solana", "other"]).optional()
          .describe("'base' (default) or 'solana' = gasless USDC; 'other' = coin/network below via deposit address"),
        coin: z.string().max(12).optional().describe("payWith='other' only: coin, e.g. 'USDT'"),
        network: z.string().max(40).optional().describe("payWith='other' only: exact network from get_cryptorefills_payment_methods, e.g. 'Tron'"),
      }),
      execute: async ({ country, brand, productId, productValue, email, phone, payWith = "base", coin, network }) => {
        try {
          const [items, brands] = await Promise.all([listCatalog(country, brand), listBrands(country)]);
          const item = items.find((it) => it.product_id === productId);
          if (!item) return { error: "That product isn't available anymore. Call get_cryptorefills_products again and pick from the list." };
          const brandInfo = brands.find((b) => b.brand_name === brand);
          const kind = kindOf(brandInfo?.category ?? "");

          let beneficiary = email;
          if (kind === "topup") {
            if (!phone) return { error: "Ask the user for the phone number to top up, then call again with phone." };
            try {
              beneficiary = parsePhoneNumberWithError(phone, country.toUpperCase() as CountryCode).format("E.164");
            } catch {
              return { error: `"${phone}" isn't a valid phone number for ${country.toUpperCase()}. Ask the user to check it.` };
            }
          }

          let priceUsd: number;
          if (item.is_range) {
            if (productValue === undefined) return { error: `Ask the user for an amount between ${item.min_value} and ${item.max_value} ${item.currency ?? ""}.` };
            if ((item.min_value !== undefined && productValue < item.min_value) || (item.max_value !== undefined && productValue > item.max_value)) {
              return { error: `Amount must be between ${item.min_value} and ${item.max_value} ${item.currency ?? ""}.` };
            }
            const quote = await quotePrice({ productId, countryCode: country, brandName: brand, productValue });
            priceUsd = Number(quote.price_usdc);
          } else {
            priceUsd = Number(item.price_usdc);
          }
          if (!(priceUsd > 0)) return { error: "Couldn't price this product right now. Try again in a moment." };
          if (priceUsd > maxOrderUsd()) return { error: `This costs $${priceUsd.toFixed(2)}, above the $${maxOrderUsd()} single-order limit.` };

          const productName = item.product_name
            ?? `${brand} ${item.is_range ? `${productValue} ${item.currency ?? ""}`.trim() : item.denomination_label ?? ""}`.trim();
          const common = {
            pendingCryptorefillsPayment: true as const,
            productName,
            priceUsd: Number(priceUsd.toFixed(2)),
            recipient: beneficiary,
            kind,
            logoUrl: brandInfo?.logo_url,
            logoBg: brandInfo?.bg_color,
          };

          if (payWith === "other") {
            if (!partnerConfigured()) return { error: "Paying with other coins isn't enabled here. Offer gasless USDC on Base or Solana instead." };
            if (!coin || !network) return { error: "Ask which coin and network the user wants (see get_cryptorefills_payment_methods), then call again." };
            const methods = await listPaymentMethods();
            const method = methods.find((m) => m.coin.toLowerCase() === coin.toLowerCase() && m.network.toLowerCase() === network.toLowerCase());
            if (!method) return { error: `${coin} on ${network} isn't available. Call get_cryptorefills_payment_methods for the current list.` };
            const partnerOrder: CrPartnerRequest = {
              email,
              brand_name: brand,
              country_code: country.toUpperCase(),
              denomination: item.is_range ? "range" : item.denomination ?? item.denomination_label ?? "",
              ...(item.is_range ? { product_value: productValue } : {}),
              beneficiary_account: beneficiary,
              coin: method.coin,
              network: method.network,
            };
            return {
              ...common,
              payWith: "other",
              partnerOrder,
              tip:
                'PAYMENT CARD SHOWN. Output only: "A payment card has been shown. Please confirm to get your payment address." Then STOP. ' +
                `The card creates the order and shows the ${method.coin} (${method.network}) address and exact amount; the user sends it from any wallet and pays the network fee. ` +
                "When it reports back with {paid:true, orderId}, tell the user their order is waiting for payment (or delivered) and the code will be emailed.",
            };
          }

          const order: CrOrderRequest = {
            email,
            items: [{ beneficiary_account: beneficiary, product_id: productId, ...(item.is_range ? { product_value: productValue } : {}) }],
          };
          return {
            ...common,
            payWith,
            rail: payWith,
            order,
            tip:
              'PAYMENT CARD SHOWN. Output only: "A payment card has been shown. Please confirm the payment." Then STOP. ' +
              "The card handles signing, delivery and shows the code itself. When it reports back with {paid:true, orderId}, " +
              "tell the user it's done (code shown in the card and emailed). If it reports {paid:false}, relay the error.",
          };
        } catch (err) {
          return { error: describeCryptorefillsError(err) };
        }
      },
    }),

    get_cryptorefills_order: tool({
      description: "Check the status of one of the user's Cryptorefills orders by order id (gasless or deposit-address orders).",
      inputSchema: z.object({ orderId: z.string().min(1).max(80) }),
      execute: async ({ orderId }) => {
        if (!userId) return { error: "Not authenticated" };
        try {
          const [row] = await db.select({ id: payments.id, chain: payments.chain }).from(payments)
            .where(and(eq(payments.userId, userId), eq(payments.referenceId, orderId))).limit(1);
          if (!row) return { error: "No Cryptorefills order with that id for this user." };

          // Voucher codes are cash-like: they're shown in the payment card and emailed, never echoed into chat.
          if (isGaslessChain(row.chain)) {
            const order = await getOrder(orderId);
            return {
              orderId: order.order_id,
              status: order.status,
              items: (order.deliveries ?? []).map((d) => ({
                product: d.product_name ?? d.brand_name,
                delivery_state: d.delivery_state,
                delivered_by: d.delivery_type,
                failure_reason: d.failure_reason,
              })),
              tip: order.status === "completed"
                ? "Delivered. The code was shown in the payment card and emailed. Don't read codes out in chat."
                : order.status === "processing"
                  ? "Still processing. Check again in about 10 seconds."
                  : "The order didn't complete. Cryptorefills refunds automatically; the user can contact support@cryptorefills.com with the order id.",
            };
          }

          const order = await getPartnerOrder(orderId);
          return {
            orderId: order.order_id,
            status: order.status,
            order_state: order.order_state,
            payment_state: order.payment_state,
            tip: {
              awaiting_payment: "Waiting for the user's deposit. They can find the address in the payment card; payment windows are 1–3 hours.",
              paid: "Payment received; delivery is in progress.",
              completed: "Delivered. The code is in the payment card and emailed. Don't read codes out in chat.",
              review: "Cryptorefills support is reviewing the order; this can take up to 24 hours.",
              expired: "The payment window closed. If the user already sent funds, they should email support@cryptorefills.com with the transaction hash.",
              failed: "The order failed. The user can contact support@cryptorefills.com with the order id.",
            }[order.status],
          };
        } catch (err) {
          return { error: describeCryptorefillsError(err) };
        }
      },
    }),

    get_cryptorefills_orders: tool({
      description: "List the user's Cryptorefills purchases (newest first) with status, amount and how they paid.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      execute: async ({ limit = 10 }) => {
        if (!userId) return { error: "Not authenticated" };
        const rows = await db
          .select({ orderId: payments.referenceId, description: payments.description, amountUsdc: payments.amountUsdc, status: payments.status, chain: payments.chain, createdAt: payments.createdAt })
          .from(payments)
          .where(and(eq(payments.userId, userId), eq(payments.type, "bill"), like(payments.description, "%via Cryptorefills%")))
          .orderBy(desc(payments.createdAt))
          .limit(limit);
        return {
          orders: rows.map((r) => ({
            ...r,
            paidWith: r.chain === "solana" ? "USDC on Solana" : r.chain === "evm" ? "USDC on Base" : `deposit on ${r.chain}`,
          })),
          tip: rows.length ? "Use get_cryptorefills_order(orderId) for live status. Never show voucher codes in chat." : "No Cryptorefills purchases yet.",
        };
      },
    }),
  };
}
