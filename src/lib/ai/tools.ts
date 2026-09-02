import { tool } from "ai";
import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { DEMO_ASSETS } from "@/lib/demo-data";
import { db } from "@/lib/db";
import { payments, bitrefillOrders } from "@/lib/db/schema";
import { getProvider } from "@/lib/banking/registry";
import { mcpSearchProducts, mcpGetProductDetails, mcpBuyProducts, mcpGetInvoice, ADDRESS_BASED_PAYMENT_METHODS } from "@/lib/bitrefill-mcp";
import { getWalletRequest } from "@/lib/xrplBackend";
import { MIN_XRP_BRIDGE_USD, markXrpPurchaseFailed } from "@/lib/xrp-purchase";

function extractMCPCode(invoice: Awaited<ReturnType<typeof mcpGetInvoice>>): string | null {
  if (!invoice.orders) return null;
  for (const order of invoice.orders) {
    const info = order.redemption_info;
    if (info) {
      const code = info.pin ?? info.code ?? null;
      if (code) return String(code);
    }
  }
  return null;
}

function getBankingProvider() {
  try { return getProvider("credible") as any; } catch { return null; }
}

/** Absolute base URL for internal API calls — falls back to localhost:3000 in dev. */
function appBase() {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function createTools(walletAddress?: string, userId?: string, solanaAddress?: string, paidBillIds: string[] = [], userName?: string) {
  // Pick the right address for a given blockchain context
  function addressFor(blockchain?: string): string {
    const chain = (blockchain ?? "").toLowerCase();
    if (chain === "solana" && solanaAddress) return solanaAddress;
    return walletAddress ?? "";
  }
  return {
    // ── Bills / Bitrefill ─────────────────────────────────────────────────────

    get_bills: tool({
      description:
        "Search and browse digital products — gift cards, mobile top-ups, eSIM data plans, and subscriptions (10,000+ products worldwide). " +
        "Use for Netflix, Spotify, Steam, gaming, shopping, travel eSIMs, phone refills, and more. " +
        "Always call this before buy_bitrefill_product to get valid product IDs and available denominations. " +
        "Works without any API key via guest checkout — set BITREFILL_MCP_URL/BITREFILL_API_KEY for an authenticated account.",
      inputSchema: z.object({
        query: z
          .string()
          .max(128)
          .optional()
          .describe("Free-text search, e.g. 'Netflix', 'Steam', 'MTN Nigeria', 'travel eSIM'"),
        category: z
          .enum(["entertainment", "gaming", "shopping", "food", "travel", "vpn", "topup", "esim", "all"])
          .optional()
          .describe(
            "Product category: 'entertainment'=streaming, 'gaming'=game cards, 'shopping'=retail, " +
            "'food'=food & groceries, 'travel'=travel cards, 'vpn'=privacy tools, " +
            "'topup'=mobile phone top-ups, 'esim'=eSIM data plans, 'all'=no filter",
          ),
        country: z
          .string()
          .length(2)
          .optional()
          .describe("ISO 3166-1 alpha-2 country code, e.g. 'US', 'NG', 'GB', 'DE'. Default 'US'."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max results to return, default 10"),
      }),
      execute: async ({ query, category, country, limit }) => {
        try {
          const cat = (!category || category === "all") ? undefined : category;
          const products = await mcpSearchProducts({
            query:   query,
            category: cat,
            country: country ?? "US",
            limit:   limit ?? 10,
          });

          return {
            products: products.map((p) => ({
              id:           p.id,
              name:         p.name,
              category:     p.category,
              currency:     p.currency,
              logo_url:     p.logo_url,
              packages:     p.packages?.map((pkg) => ({
                package_value: pkg.package_value,
                price_usd:     pkg.price_usd,
              })) ?? null,
              range:        p.range ?? null,
              recipient_type: p.recipient_type ?? null,
              countries:    p.countries,
            })),
            count:   products.length,
            country: country ?? "US",
            tip:     "Call buy_bitrefill_product with product id and package_value. Always collect the user's email first for guest checkout.",
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Catalog unavailable";
          console.error("[get_bills] MCP error:", msg);
          return { error: msg, products: [], count: 0 };
        }
      },
    }),

    get_product_details: tool({
      description:
        "Get full details for a specific Bitrefill product — all denominations with exact package_value, " +
        "range pricing, recipient_type (phone/email/account), and the exact payment method ids this product " +
        "accepts (Bitrefill support for USDT/USDC on Base and Optimism varies by product). " +
        "Call this AFTER get_bills and BEFORE buy_bitrefill_product to confirm the exact package_value " +
        "for the denomination the user wants, AND to confirm the paymentMethod you're about to pass is in " +
        "supported_payment_methods — do not offer a network/token combo that isn't listed there.",
      inputSchema: z.object({
        productId: z
          .string()
          .max(128)
          .describe("Product id from get_bills, e.g. 'netflix-us', 'amazon_com-usa'"),
        currency: z
          .string()
          .max(8)
          .optional()
          .describe("Preferred currency for prices, e.g. 'USD', 'EUR', 'NGN'. Defaults to USD."),
      }),
      execute: async ({ productId, currency }) => {
        try {
          const product = await mcpGetProductDetails(productId);
          const pm = product.payment_methods;
          const supportedPaymentMethods = [
            ...(pm?.address_based ?? []),
            ...(pm?.link_only ?? []),
            ...(pm?.balance ?? []),
          ];
          return {
            id:             product.id,
            name:           product.name,
            category:       product.category,
            currency:       product.currency,
            recipient_type: product.recipient_type ?? null,
            packages:       product.packages?.map((p) => ({
              package_value: p.package_value,
              price_usd:     p.price_usd,
            })) ?? null,
            range:          product.range ?? null,
            supported_payment_methods: supportedPaymentMethods,
            tip:            `Use package_value (e.g. "${product.packages?.[0]?.package_value ?? "15"}") as packageValue in buy_bitrefill_product. ` +
              `Only pass a paymentMethod that appears in supported_payment_methods for this product.`,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Product fetch failed";
          return { error: msg };
        }
      },
    }),

    buy_bitrefill_product: tool({
      description:
        "Purchase a digital product (gift card, mobile top-up, eSIM) via Bitrefill guest checkout. " +
        "ALWAYS call get_bills then get_product_details first to get the exact product id and package_value. " +
        "Collect the user's email BEFORE calling this — required for all purchases. " +
        "This tool creates the invoice and returns the payment details. " +
        "For USDC/USDT on EVM or Solana the UI sends the payment automatically. " +
        "For all other payment methods (Bitcoin, Lightning, BSC, Tron, TON, etc.) the UI shows a deposit address. " +
        "IMPORTANT — set isTopup=true when recipient_type='phone_number': airtime goes directly to the phone, there is NO code. " +
        "For gift cards/eSIM (recipient_type != 'phone_number') the code is shown in chat AND emailed to recipientEmail.",
      inputSchema: z.object({
        productId: z
          .string()
          .max(128)
          .describe("Product id from get_bills, e.g. 'netflix-us', 'mtn-nigeria'"),
        packageValue: z
          .string()
          .max(64)
          .describe("Package denomination from get_bills packages[].package_value, e.g. '15', '1GB, 7 Days'"),
        recipientEmail: z
          .string()
          .email()
          .describe("User's email — required for all purchases. Receives the code for gift cards, or a confirmation receipt for top-ups."),
        recipientName: z
          .string()
          .max(64)
          .optional()
          .describe("User's display name for the delivery email (optional)"),
        paymentMethod: z
          .string()
          .optional()
          .describe(
            "Bitrefill payment method id. Defaults to 'usdc_base' (USDC on Base — paid automatically by the UI). " +
            "Automatic-pay USDC options: 'usdc_base', 'usdc_erc20', 'usdc_polygon', 'usdc_arbitrum', 'usdc_optimism', 'usdc_solana'. " +
            "Automatic-pay USDT options: 'usdt_erc20', 'usdt_base', 'usdt_polygon', 'usdt_arbitrum', 'usdt_optimism', 'usdt_solana'. " +
            "'usdt_bsc', 'usdc_bsc' (BSC — deposit address shown, no automatic-pay support). " +
            "'bitcoin', 'lightning', 'litecoin', 'dogecoin', 'ton', 'ethereum', 'solana' (native crypto — deposit address shown). " +
            "'xrp' — Bluvfi-only option, NOT a native Bitrefill method: settles the invoice in USDC behind the scenes, " +
            `user sends XRP and it's converted automatically. Deposit address + a short time-to-send countdown (~7.5 min) shown to user. Minimum item price ~$${MIN_XRP_BRIDGE_USD.toFixed(2)} — for anything cheaper, tell the user upfront and suggest a different payment method instead of calling this tool. ` +
            "IMPORTANT: never say 'swap', 'bridge', 'NEAR Intents', or explain the underlying conversion mechanism to the user — describe this only as \"paying with XRP\"; if something fails, say the payment couldn't be completed, not that a swap/bridge failed. " +
            "Do not check this one against get_product_details's supported_payment_methods — it works for any product. " +
            "Bitrefill's support for the other ids varies per product (especially usdt_base/usdt_optimism/usdc_optimism) — " +
            "call get_product_details first and only pass a value present in its supported_payment_methods list. " +
            "Only change from the default if the user explicitly asks for a different network or token."
          ),
        sendTo: z
          .string()
          .max(30)
          .optional()
          .describe("Phone number for mobile top-ups in E.164 format, e.g. '+2348012345678'"),
        isTopup: z
          .boolean()
          .optional()
          .describe(
            "Set to true when recipient_type='phone_number' (mobile top-ups / airtime). " +
            "Airtime is credited directly to the phone — no code is issued. " +
            "The email receives a payment confirmation receipt only."
          ),
      }),
      execute: async ({ productId, packageValue, recipientEmail, recipientName, paymentMethod, sendTo, isTopup }) => {
        const resolvedMethod = paymentMethod ?? "usdc_base";

        // "xrp" is a Bluvfi-only pseudo-method — not a native Bitrefill payment
        // method. The underlying invoice always settles in USDC; XRP gets
        // swapped into it via the bluvfi-xrpl service. Handled entirely
        // separately from the normal mcpBuyProducts flow below.
        if (resolvedMethod === "xrp") {
          try {
            const { initiateXrpPurchase } = await import("@/lib/xrp-purchase");
            const xrp = await initiateXrpPurchase({
              productId,
              packageId: packageValue,
              privyDid: userId ?? "",
              recipientEmail,
              recipientName,
              sendTo,
            });
            return {
              pendingBitrefillPayment: true,
              invoiceId:        xrp.invoiceId,
              accessToken:      xrp.invoiceAccessToken,
              productId,
              packageValue,
              paymentMethod:    "xrp",
              paymentAddress:   xrp.paymentAddress,
              // requiredActivationXrp, NOT swapAmountDrops alone — bluvfi-xrpl
              // requires the reserve (~1.05 XRP) AND the swap amount both
              // present before the wallet even activates. swapAmountDrops is
              // only the swap portion; using it alone (a bug this mirrors —
              // now fixed in bills-screen.tsx's equivalent flow too) would
              // tell the user to send less than the network requires, and
              // the wallet would never activate.
              paymentAmount:    xrp.requiredActivationXrp,
              paymentCurrency:  "XRP",
              isAddressBased:   true,
              isTopup:          !!isTopup,
              recipientEmail,
              expiresInMinutes: xrp.expirationMinutes,
              tip: `Deposit address shown to user — they must send exactly ${xrp.requiredActivationXrp} XRP (this already includes the ~1.05 XRP network reserve required to activate a new address, not an extra fee) within about 7.5 minutes or the payment window closes. Once sent, call poll_bitrefill_order(invoiceId="${xrp.invoiceId}"${isTopup ? ", isTopup=true" : ""}). Do not mention "swap"/"bridge"/"NEAR Intents" to the user — describe this only as paying with XRP.`,
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "XRP purchase failed";
            return { error: message };
          }
        }

        // Address-based methods: Bitrefill returns a deposit address; UI shows it to the user.
        // Automatic-pay methods: UI sends the payment via the Privy smart wallet →
        // Privy EOA → ArcKit cascade without user intervention. Shared with the
        // dashboard's invoice route so bitrefill_orders.isAddressBased means the
        // same thing regardless of which purchase path created the row.
        const isAddressBased = ADDRESS_BASED_PAYMENT_METHODS.has(resolvedMethod);

        try {
          const invoice = await mcpBuyProducts({
            productId,
            packageId:         packageValue,
            paymentMethod:     resolvedMethod,
            recipientEmail,
            recipientName,
            refillInput:       sendTo,
            // Address-based methods also need the payment_link: bitcoin, ton,
            // usdt_ton, ark, and solana never return an altcoinPrice/amount under
            // guest checkout — payment_link (Bitrefill's own hosted checkout,
            // which does show the exact amount) is the only fallback. Verified
            // requesting it doesn't remove payment_info.address for these methods.
            returnPaymentLink: isAddressBased,
          });

          if (!invoice.payment_info?.address) {
            return {
              error:     "No payment address returned from Bitrefill",
              invoiceId: invoice.invoice_id,
              hint:      invoice.agent_instructions,
            };
          }

          const depositAddress  = invoice.payment_info.address;
          const depositAmount   = invoice.payment_info.altcoinPrice ?? invoice.payment_info.amount;
          const depositCurrency = invoice.payment_info.currency;

          // Record invoice in bitrefill_orders (full lifecycle table) + payments ledger
          if (userId) {
            const orderChain = resolvedMethod.includes("solana") ? "solana" : "evm";
            const orderAmountUsdc = depositAmount != null ? String(depositAmount) : "0";
            // 1. Upsert into bitrefill_orders
            db.insert(bitrefillOrders).values({
              userId,
              invoiceId: invoice.invoice_id,
              productId,
              productName: productId,
              packageValue,
              paymentMethod: resolvedMethod,
              isAddressBased,
              paymentAddress: depositAddress,
              paymentAmount: depositAmount != null ? String(depositAmount) : null,
              paymentCurrency: depositCurrency,
              amountUsdc: orderAmountUsdc,
              recipientEmail,
              chain: orderChain,
              status: "pending",
            }).onConflictDoUpdate({
              target: [bitrefillOrders.invoiceId],
              set: { status: "pending", updatedAt: new Date() },
            }).catch(() => {});
            // 2. Pending row in payments ledger — updated to completed by poll_bitrefill_order
            db.insert(payments).values({
              userId,
              type: "bill",
              referenceId: invoice.invoice_id,
              description: `Bitrefill: ${productId} ${packageValue}`,
              amountUsdc: orderAmountUsdc,
              status: "pending",
              txHash: null,
              chain: orderChain,
            }).catch(() => {});
          }

          // Bitcoin, TON, usdt_ton, ark, and solana never return an altcoinPrice/amount
          // under guest checkout (confirmed against the live API — not a timing issue,
          // the data is simply absent). payment_link is the only source of the exact
          // amount for these; direct the user there instead of showing "undefined".
          const amountKnown = depositAmount != null;
          const paymentLink = invoice.payment_link;

          return {
            pendingBitrefillPayment: true,
            invoiceId:        invoice.invoice_id,
            accessToken:      invoice.invoice_access_token,
            productId,
            packageValue,
            paymentMethod:    resolvedMethod,
            paymentAddress:   depositAddress,
            paymentAmount:    depositAmount,
            paymentCurrency:  depositCurrency,
            paymentUri:       invoice.payment_info.paymentUri,
            paymentLink,
            isAddressBased,
            isTopup:          !!isTopup,
            recipientEmail,
            expiresInMinutes: invoice.expiration_minutes,
            tip: isAddressBased
              ? amountKnown
                ? (isTopup
                    ? `Deposit address shown to user — they must send exactly ${depositAmount} ${depositCurrency} manually. Once sent, call poll_bitrefill_order(invoiceId="${invoice.invoice_id}", isTopup=true). Airtime credited directly to the phone; receipt to ${recipientEmail}.`
                    : `Deposit address shown to user — they must send exactly ${depositAmount} ${depositCurrency} manually. Once sent, call poll_bitrefill_order(invoiceId="${invoice.invoice_id}"). Code will be emailed to ${recipientEmail} after confirmation.`)
                : `Deposit address shown to user, but Bitrefill did not provide an exact amount for this payment method. Tell the user to open ${paymentLink ?? "the payment link"} to see the exact amount to send (Bitrefill's own checkout page), then send that amount to the address already shown. Once sent, call poll_bitrefill_order(invoiceId="${invoice.invoice_id}"${isTopup ? ", isTopup=true" : ""}).`
              : isTopup
                ? `PAYMENT CARD SHOWN. Output only: "A payment card has been shown. Please confirm the payment." Then STOP. When you next receive {paid:true}, your FIRST action must be to call poll_bitrefill_order(invoiceId="${invoice.invoice_id}", isTopup=true) — no text before the call. Keep retrying every ~3 s up to 20 times until complete/failed/expired. Airtime credited directly to phone; receipt to ${recipientEmail}.`
                : `PAYMENT CARD SHOWN. Output only: "A payment card has been shown. Please confirm the payment." Then STOP. When you next receive {paid:true}, your FIRST action must be to call poll_bitrefill_order(invoiceId="${invoice.invoice_id}") — no text before the call. Keep retrying every ~3 s up to 20 times until complete/failed/expired. Code emailed to ${recipientEmail} on completion.`,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Purchase failed";
          return { error: message };
        }
      },
    }),

    poll_bitrefill_order: tool({
      description:
        "Check a Bitrefill invoice status until it is complete. " +
        "Call this immediately after receiving {paid:true} from buy_bitrefill_product. " +
        "Checks the local DB first (webhook may have already delivered the result). " +
        "If the status is still pending/processing, call this tool again in ~10 seconds — keep retrying up to 20 times without asking the user anything. " +
        "For gift cards/eSIM: returns the redemption code or install link. " +
        "For mobile top-ups (isTopup=true): confirms airtime was credited — there is no code.",
      inputSchema: z.object({
        invoiceId: z
          .string()
          .describe("Invoice ID from buy_bitrefill_product, e.g. '6654a2ea-0df7-4f44-bc72-c1c6ad8b7b34'"),
        productName: z
          .string()
          .max(128)
          .optional()
          .describe("Product name for display, e.g. 'Netflix Gift Card' or 'MTN Nigeria'"),
        isTopup: z
          .boolean()
          .optional()
          .describe("Set to true for mobile top-ups — airtime is credited directly, no code is expected."),
      }),
      execute: async ({ invoiceId, productName, isTopup }) => {
        try {
          // ── DB-first: webhook may have already delivered the terminal state ──
          // This avoids an MCP round-trip (and quota consumption) when the webhook
          // fires before the AI polls.
          const [dbRow] = await db
            .select()
            .from(bitrefillOrders)
            .where(eq(bitrefillOrders.invoiceId, invoiceId))
            .limit(1)
            .catch(() => [undefined]);

          if (dbRow && (dbRow.status === "complete" || dbRow.status === "failed" || dbRow.status === "expired")) {
            if (dbRow.status === "complete") {
              const code = dbRow.redemptionCode ?? null;
              const esimLink = dbRow.esimInstallLink ?? null;
              if (isTopup || (!code && !esimLink)) {
                return {
                  status:      "complete",
                  code:        null,
                  invoiceId,
                  productName: productName ?? "Mobile top-up",
                  isTopup:     true,
                  message:     `✅ Airtime has been credited directly to the phone. Check the phone balance to confirm. A receipt was sent to the registered email.`,
                };
              }
              return {
                status:          "complete",
                code,
                invoiceId,
                productName:     productName ?? "Digital product",
                esimInstallLink: esimLink,
                message: esimLink
                  ? `✅ Your eSIM is ready. Install link: ${esimLink}`
                  : `✅ Your ${productName ?? "code"} is ready: **${code}**`,
              };
            }
            return { status: dbRow.status, invoiceId, error: `Payment ${dbRow.status} — please try again.` };
          }

          // ── XRP swap-failure detection ─────────────────────────────────────
          // For a "pay with XRP" purchase, Bitrefill's own invoice never receives
          // anything if the swap fails (underpayment guard, expiry, refund) — its
          // status just sits at "unpaid" forever, so without this check the MCP
          // fallback below would have the AI retry blindly for the full 20
          // attempts with no accurate explanation of what went wrong (the same
          // gap already fixed on the dashboard via /api/xrpl/wallet-status
          // polling in bills-screen.tsx — mirrored here for the chat path).
          if (dbRow?.xrplWalletRequestId) {
            try {
              const wallet = await getWalletRequest(dbRow.xrplWalletRequestId);
              if (
                wallet.swapStatus === "FAILED" ||
                wallet.swapStatus === "REFUNDED" ||
                wallet.swapStatus === "EXPIRED"
              ) {
                const failStatus = wallet.swapStatus === "EXPIRED" ? "expired" : "failed";
                // Shared with the webhook and the dashboard's wallet-status
                // poll — writes both bitrefill_orders AND payments, so
                // History and this same check agree on what happened
                // regardless of which surface detects it first.
                await markXrpPurchaseFailed(dbRow.xrplWalletRequestId, failStatus);
                return {
                  status: failStatus,
                  invoiceId,
                  error:
                    "The payment didn't go through, but the funds never left safekeeping. " +
                    "Tell the user this purchase failed and their funds are safe, then offer to recover them right now — " +
                    "call list_recoverable_xrp to get the exact amount, state it to the user, and only call recover_xrp_order once they explicitly agree. " +
                    "They can also do this later from the Bills page if they'd rather not right now.",
                };
              }
            } catch {
              // bluvfi-xrpl lookup failed — don't block the normal flow on this,
              // just fall through to the regular Bitrefill status check below.
            }
          }

          // ── MCP fallback — webhook hasn't arrived yet ─────────────────────
          const invoice = await mcpGetInvoice(invoiceId);
          const code = extractMCPCode(invoice);

          if (invoice.status === "complete") {
            const order = invoice.orders?.[0];
            const esimLink = order?.esim_install_link ?? null;
            // Update both tables to completed
            if (userId) {
              db.update(payments)
                .set({ status: "completed" })
                .where(and(eq(payments.userId, userId), eq(payments.referenceId, invoiceId)))
                .catch(() => {});
              db.update(bitrefillOrders)
                .set({
                  status: "complete",
                  ...(code ? { redemptionCode: code } : {}),
                  ...(esimLink ? { esimInstallLink: esimLink } : {}),
                  updatedAt: new Date(),
                })
                .where(eq(bitrefillOrders.invoiceId, invoiceId))
                .catch(() => {});
            }

            // Mobile top-up: no code, airtime was credited directly to the phone
            if (isTopup || (!code && !esimLink)) {
              return {
                status:      "complete",
                code:        null,
                invoiceId,
                productName: productName ?? "Mobile top-up",
                isTopup:     true,
                message:     `✅ Airtime has been credited directly to the phone. Check the phone balance to confirm. A receipt was sent to the registered email.`,
              };
            }

            return {
              status:          "complete",
              code,
              invoiceId,
              productName:     productName ?? "Digital product",
              esimInstallLink: esimLink,
              instructions:    order?.redemption_info?.instructions ?? null,
              message: esimLink
                ? `✅ Your eSIM is ready. Install link: ${esimLink}`
                : `✅ Your ${productName ?? "code"} is ready: **${code}**`,
            };
          }

          if (invoice.status === "failed" || invoice.status === "expired") {
            // Update both tables to failed/expired
            if (userId) {
              db.update(payments)
                .set({ status: "failed" })
                .where(and(eq(payments.userId, userId), eq(payments.referenceId, invoiceId)))
                .catch(() => {});
              db.update(bitrefillOrders)
                .set({ status: invoice.status, updatedAt: new Date() })
                .where(eq(bitrefillOrders.invoiceId, invoiceId))
                .catch(() => {});
            }
            return { status: invoice.status, invoiceId, error: `Payment ${invoice.status} — please try again.` };
          }

          // Still pending — Bitrefill is processing the payment
          return {
            status:    invoice.status,
            invoiceId,
            message:   invoice.status === "payment_detected"
              ? "Payment detected by Bitrefill — confirming on-chain…"
              : "Payment received — Bitrefill is processing the order…",
            tip:       "Payment was already sent by the client card. Call poll_bitrefill_order again in ~3 seconds (do NOT ask the user anything — keep retrying up to 20 times until status is complete/failed/expired).",
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Status check failed";
          return { error: message, invoiceId };
        }
      },
    }),

    // ── XRP recovery ──────────────────────────────────────────────────────────
    // Two tools, deliberately split into a free-to-call read (list) and a
    // fund-moving write (recover) that requires the AI to confirm with the
    // user first — same pattern as every other fund-movement tool in this
    // file (e.g. rebalance_velvet_portfolio: "Always confirm details before
    // calling"). Both call the exact same shared functions
    // (src/lib/xrp-purchase.ts) that back bills-screen.tsx's "My Bills"
    // recovery list and /api/xrpl/transfer's recovery-direction branch, so
    // an AI-initiated recovery can never disagree with a dashboard-initiated
    // one about what's recoverable or how much.

    list_recoverable_xrp: tool({
      description:
        "List the user's \"pay with XRP\" purchases that failed AFTER the deposit wallet was already funded — " +
        "meaning real XRP is sitting safe but stuck, un-recovered. Call this when the user asks about a failed " +
        "XRP payment, mentions missing/stuck XRP, or after poll_bitrefill_order reports a failed XRP purchase " +
        "and you want the exact recoverable amount before offering to recover it. Read-only, no confirmation needed. " +
        "Do not mention 'swap'/'bridge'/'NEAR Intents' — describe these only as failed XRP payments.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!userId) return { error: "Not authenticated" };
        try {
          const { listRecoverableXrpOrders } = await import("@/lib/xrp-purchase");
          const orders = await listRecoverableXrpOrders(userId);
          if (orders.length === 0) {
            return { orders: [], message: "No stuck XRP payments found — nothing to recover right now." };
          }
          return {
            orders: orders.map((o) => ({
              walletRequestId: o.walletRequestId,
              productName:     o.productName,
              recoverableXrp:  o.recoverableXrp,
              failedAt:        o.failedAt,
            })),
            tip: "Tell the user the product name and exact XRP amount for each, and confirm with them before calling recover_xrp_order — never recover without the user explicitly agreeing to it.",
          };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : "Failed to list recoverable payments" };
        }
      },
    }),

    recover_xrp_order: tool({
      description:
        "Move a failed XRP payment's stuck funds back to the user's own Bluvfi XRP wallet (the sidebar wallet). " +
        "REQUIRES explicit user confirmation first — always call list_recoverable_xrp, state the exact product and " +
        "XRP amount to the user, and get a clear yes before calling this. Never call this speculatively or as part " +
        "of a retry loop. Moves real funds — there is no undo. " +
        "Do not mention 'swap'/'bridge'/'NEAR Intents' to the user at any point in this flow.",
      inputSchema: z.object({
        walletRequestId: z
          .string()
          .describe("The walletRequestId from list_recoverable_xrp for the specific payment the user confirmed."),
      }),
      execute: async ({ walletRequestId }) => {
        if (!userId) return { error: "Not authenticated" };
        try {
          const { recoverXrpOrder } = await import("@/lib/xrp-purchase");
          const result = await recoverXrpOrder(userId, walletRequestId);
          return {
            recovered:  true,
            recoveredXrp: result.recoveredXrp,
            productName: result.productName,
            message: `✅ ${result.recoveredXrp.toFixed(4)} XRP from the failed "${result.productName}" payment has been moved to the user's Bluvfi XRP wallet.`,
          };
        } catch (err: unknown) {
          return { recovered: false, error: err instanceof Error ? err.message : "Recovery failed" };
        }
      },
    }),

    // ── Investments ───────────────────────────────────────────────────────────

    get_investments: tool({
      description:
        "List available investments — stocks, pre-IPO companies, and ETFs with current prices and 24h change.",
      inputSchema: z.object({
        type: z
          .enum(["stock", "ipo", "etf", "all"])
          .optional()
          .describe("Filter by asset type"),
      }),
      execute: async ({ type }) => {
        const list =
          type && type !== "all"
            ? DEMO_ASSETS.filter((a) => a.type === type)
            : DEMO_ASSETS;
        return {
          assets: list.map((a) => ({
            symbol: a.symbol,
            name: a.name,
            type: a.type,
            priceUsd: a.priceUsd,
            change24h: a.change24h,
            description: a.description,
          })),
        };
      },
    }),

    buy_investment: tool({
      description:
        "Queue an investment purchase for user confirmation. Returns a pending action that renders a Confirm card in the UI. " +
        "The card lets the user choose to pay in USDC on Base (EVM) or Solana — the actual transfer and portfolio update happen client-side when they tap Confirm. " +
        "Pass network='evm' or network='solana' to pre-select and lock a network; omit to show the selector. " +
        "Minimum payment is $0.000001 USDC (1 base unit) on both networks — reject if shares × price would be below this.",
      inputSchema: z.object({
        symbol: z
          .string()
          .max(16)
          .describe("Ticker symbol to buy, e.g. AAPL, TSLA, SPACEX, SPY"),
        shares: z
          .string()
          .max(32)
          .describe("Number of shares to buy, e.g. '1', '0.5', '2'"),
        network: z
          .enum(["evm", "solana"])
          .optional()
          .describe(
            "Which network to pay on. Pass 'evm' for Base (EVM) USDC or 'solana' for Solana USDC. " +
            "Omit to let the user choose in the UI. Pass when the user has explicitly requested a specific network.",
          ),
      }),
      execute: async ({ symbol, shares, network }) => {
        const sym = symbol.toUpperCase();
        const asset = DEMO_ASSETS.find((a) => a.symbol === sym);

        if (!asset) {
          return {
            error: `Unknown symbol: ${sym}. Use get_investments to see available assets.`,
          };
        }

        const sharesNum = Number(shares);
        if (isNaN(sharesNum) || sharesNum <= 0) {
          return { error: "Invalid number of shares" };
        }

        const totalUsdc = sharesNum * asset.priceUsd;
        if (totalUsdc < 0.000001) {
          return {
            error: `Total cost $${totalUsdc.toFixed(6)} USDC is below the $0.000001 minimum. Increase the number of shares.`,
          };
        }

        // Return pending — the UI renders a confirm card with network selector.
        // If network is specified it locks the selector; otherwise user picks in UI.
        return {
          pendingPurchase: true,
          symbol: sym,
          assetName: asset.name,
          shares: sharesNum,
          priceUsd: asset.priceUsd,
          totalUsdc,
          icon: asset.icon,
          type: asset.type,
          ...(network ? { network } : {}),
        };
      },
    }),

    get_market_prices: tool({
      description:
        "Get current prices and 24h change for all available stocks, ETFs, and pre-IPO companies.",
      inputSchema: z.object({
        type: z
          .enum(["stock", "ipo", "etf", "all"])
          .optional()
          .describe("Filter by asset type"),
        symbol: z
          .string()
          .optional()
          .describe("Get details for a specific symbol"),
      }),
      execute: async ({ type, symbol }) => {
        let list = DEMO_ASSETS;
        if (symbol) {
          list = DEMO_ASSETS.filter((a) => a.symbol === symbol.toUpperCase());
        } else if (type && type !== "all") {
          list = DEMO_ASSETS.filter((a) => a.type === type);
        }
        return {
          assets: list.map((a) => ({
            symbol: a.symbol,
            name: a.name,
            type: a.type,
            priceUsd: a.priceUsd,
            change24h: a.change24h,
            description: a.description,
          })),
        };
      },
    }),

    doma_search_names: tool({
      description: "Search tokenized internet domains on Doma Protocol. Use when the user asks about DomainFi, tokenized domains, or domain availability/listings.",
      inputSchema: z.object({
        name: z.string().optional().describe("Domain or partial name, e.g. example.com"),
        take: z.number().int().optional().describe("Number of records to return"),
      }),
      execute: async (args) => {
        try {
          const { searchDomaNames } = await import("@/lib/doma");
          return await searchDomaNames(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_name: tool({
      description: "Inspect a single Doma tokenized domain by full domain name.",
      inputSchema: z.object({ name: z.string().describe("Full domain, e.g. example.com") }),
      execute: async ({ name }) => {
        try {
          const { getDomaName } = await import("@/lib/doma");
          return await getDomaName(name);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_tokens: tool({
      description: "List token records for a Doma domain.",
      inputSchema: z.object({
        name: z.string(),
        skip: z.number().int().optional(),
        take: z.number().int().optional(),
      }),
      execute: async ({ name, skip, take }) => {
        try {
          const { getDomaTokens } = await import("@/lib/doma");
          return await getDomaTokens(name, skip, take);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_token: tool({
      description: "Inspect a specific Doma name ownership token by tokenId, including owner, expiry, explorer URL, and recent token activity.",
      inputSchema: z.object({ tokenId: z.string() }),
      execute: async ({ tokenId }) => {
        try {
          const { getDomaToken } = await import("@/lib/doma");
          return await getDomaToken(tokenId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_name_activities: tool({
      description: "Fetch Doma activity history for a tokenized domain name, such as tokenization, transfers, bridging, listings, offers, or lifecycle events.",
      inputSchema: z.object({
        name: z.string().describe("Full domain, e.g. example.com"),
        skip: z.number().int().optional(),
        take: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { getDomaNameActivities } = await import("@/lib/doma");
          return await getDomaNameActivities(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_token_activities: tool({
      description: "Fetch Doma activity history for a specific domain ownership tokenId.",
      inputSchema: z.object({
        tokenId: z.string(),
        skip: z.number().int().optional(),
        take: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { getDomaTokenActivities } = await import("@/lib/doma");
          return await getDomaTokenActivities(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_command: tool({
      description: "Track a Doma client-initiated command such as tokenization or bridging by correlationId.",
      inputSchema: z.object({ correlationId: z.string() }),
      execute: async ({ correlationId }) => {
        try {
          const { getDomaCommand } = await import("@/lib/doma");
          return await getDomaCommand(correlationId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_generate_metadata: tool({
      description: "Generate Doma token metadata for ownership or synthetic domain tokens before or after tokenization.",
      inputSchema: z.object({
        tokens: z.array(z.object({
          name: z.string(),
          networkId: z.string().describe("CAIP-2 network ID, e.g. eip155:97476"),
          type: z.enum(["OWNERSHIP", "SYNTHETIC"]),
          startsAt: z.string().optional(),
          expiresAt: z.string(),
        })),
      }),
      execute: async ({ tokens }) => {
        try {
          const { generateDomaMetadata } = await import("@/lib/doma");
          return await generateDomaMetadata(tokens);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_initiate_email_verification: tool({
      description: "Start Doma email verification for registrant contact voucher creation.",
      inputSchema: z.object({ email: z.string().email() }),
      execute: async ({ email }) => {
        try {
          const { initiateDomaEmailVerification } = await import("@/lib/doma");
          return await initiateDomaEmailVerification(email);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_complete_email_verification: tool({
      description: "Complete Doma email verification with the code the user received and return the verification proof.",
      inputSchema: z.object({ email: z.string().email(), code: z.string() }),
      execute: async (args) => {
        try {
          const { completeDomaEmailVerification } = await import("@/lib/doma");
          return await completeDomaEmailVerification(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_upload_registrant_contacts: tool({
      description: "Upload Doma registrant contact data with an email verification proof to receive a proof-of-contacts voucher for registrar/tokenization flows.",
      inputSchema: z.object({
        contact: z.record(z.string(), z.unknown()),
        emailVerificationProof: z.string(),
        networkId: z.string(),
        registrarIanaId: z.number().int(),
      }),
      execute: async (args) => {
        try {
          const { uploadDomaRegistrantContacts } = await import("@/lib/doma");
          return await uploadDomaRegistrantContacts(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_upload_verified_registrant_contacts: tool({
      description: "Upload already verified Doma registrant contact data to receive a proof-of-contacts voucher for registrar/tokenization flows.",
      inputSchema: z.object({
        contact: z.record(z.string(), z.unknown()),
        networkId: z.string(),
        registrarIanaId: z.number().int(),
      }),
      execute: async (args) => {
        try {
          const { uploadDomaVerifiedRegistrantContacts } = await import("@/lib/doma");
          return await uploadDomaVerifiedRegistrantContacts(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_network_info: tool({
      description: "Show Doma network, bridge, RPC, explorer, API endpoints, and deployed core contract addresses for the configured environment.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { getDomaNetworkInfo } = await import("@/lib/doma");
          return getDomaNetworkInfo();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_config: tool({
      description: "Check Bluvfi's Doma Protocol configuration, including environment, API base, GraphQL URL, API-key presence, network, and contracts.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { getDomaConfig } = await import("@/lib/doma");
          return getDomaConfig();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_fractionalization_info: tool({
      description: "Explain Doma fractionalization capabilities: fractionalize a domain NFT, buyout, redemption, launchpad, vesting, USDC.e, and required wallet/contract steps.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { getDomaFractionalizationInfo } = await import("@/lib/doma");
          return getDomaFractionalizationInfo();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_lifecycle_workflows: tool({
      description: "Explain actionable Doma lifecycle workflows: tokenize a domain, bridge a name token, claim a transferred domain, list/buy/sell, and detokenize.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { getDomaLifecycleWorkflows } = await import("@/lib/doma");
          return getDomaLifecycleWorkflows();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_orderbook_fees: tool({
      description: "Get Doma Orderbook fee information for a supported orderbook, chain, and token contract.",
      inputSchema: z.object({
        orderbook: z.enum(["DOMA", "OPENSEA"]).default("DOMA"),
        chainId: z.string().describe("CAIP-2 chain ID, e.g. eip155:97476"),
        contractAddress: z.string().describe("Name token contract address"),
      }),
      execute: async (args) => {
        try {
          const { getDomaOrderbookFees } = await import("@/lib/doma");
          return await getDomaOrderbookFees(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_supported_currencies: tool({
      description: "Get Doma Orderbook supported payment currencies for a chain and token contract.",
      inputSchema: z.object({
        orderbook: z.enum(["DOMA", "OPENSEA"]).default("DOMA"),
        chainId: z.string().describe("CAIP-2 chain ID, e.g. eip155:97476"),
        contractAddress: z.string().describe("Name token contract address"),
      }),
      execute: async (args) => {
        try {
          const { getDomaSupportedCurrencies } = await import("@/lib/doma");
          return await getDomaSupportedCurrencies(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_supported_tlds: tool({
      description: "List Doma-supported TLDs, optionally filtered by a substring.",
      inputSchema: z.object({ query: z.string().optional() }),
      execute: async ({ query }) => {
        try {
          const { getDomaSupportedTlds } = await import("@/lib/doma");
          return getDomaSupportedTlds(query);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_listings: tool({
      description: "Browse Doma marketplace buy-now listings for tokenized domains.",
      inputSchema: z.object({
        sld: z.string().optional().describe("Second-level domain without TLD, e.g. example"),
        take: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { getDomaListings } = await import("@/lib/doma");
          return await getDomaListings(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_offers: tool({
      description: "Browse active Doma marketplace offers, optionally for a tokenId.",
      inputSchema: z.object({
        tokenId: z.string().optional(),
        take: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { getDomaOffers } = await import("@/lib/doma");
          return await getDomaOffers({ ...args, status: "ACTIVE" });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_name_statistics: tool({
      description: "Get Doma marketplace statistics for a tokenId such as floor price, highest offer, and sales data.",
      inputSchema: z.object({ tokenId: z.string() }),
      execute: async ({ tokenId }) => {
        try {
          const { getDomaNameStatistics } = await import("@/lib/doma");
          return await getDomaNameStatistics(tokenId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_prepare_buy: tool({
      description: "Prepare Doma marketplace fulfillment data for buying a listing. The user must still sign the returned transaction/calldata in their EVM wallet.",
      inputSchema: z.object({
        orderId: z.string(),
        buyer: z.string().optional().describe("Buyer wallet; defaults to user's EVM wallet"),
      }),
      execute: async ({ orderId, buyer }) => {
        try {
          const { getDomaListingFulfillment } = await import("@/lib/doma");
          return await getDomaListingFulfillment({ orderId, buyer: buyer ?? walletAddress ?? "" });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_prepare_accept_offer: tool({
      description: "Prepare Doma marketplace fulfillment data for accepting an offer. The user must still sign the returned transaction/calldata in their EVM wallet.",
      inputSchema: z.object({
        orderId: z.string(),
        fulfiller: z.string().optional().describe("Fulfiller wallet; defaults to user's EVM wallet"),
      }),
      execute: async ({ orderId, fulfiller }) => {
        try {
          const { getDomaOfferFulfillment } = await import("@/lib/doma");
          return await getDomaOfferFulfillment({ orderId, fulfiller: fulfiller ?? walletAddress ?? "" });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_create_listing: tool({
      description: "Submit a signed Doma/OpenSea fixed-price listing to the Doma Orderbook API. Requires a valid EIP-712 order signature produced by the user's wallet.",
      inputSchema: z.object({
        orderbook: z.enum(["DOMA", "OPENSEA"]).default("DOMA"),
        chainId: z.string().describe("CAIP-2 chain ID, e.g. eip155:97476"),
        parameters: z.record(z.string(), z.unknown()),
        signature: z.string(),
        cancelExisting: z.boolean().default(false),
      }),
      execute: async (args) => {
        try {
          const { createDomaListing } = await import("@/lib/doma");
          return await createDomaListing(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_create_offer: tool({
      description: "Submit a signed Doma/OpenSea offer to the Doma Orderbook API. Requires a valid EIP-712 order signature produced by the user's wallet.",
      inputSchema: z.object({
        orderbook: z.enum(["DOMA", "OPENSEA"]).default("DOMA"),
        chainId: z.string(),
        parameters: z.record(z.string(), z.unknown()),
        signature: z.string(),
        cancelExisting: z.boolean().default(false),
      }),
      execute: async (args) => {
        try {
          const { createDomaOffer } = await import("@/lib/doma");
          return await createDomaOffer(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_create_bulk_listings: tool({
      description: "Submit multiple signed Doma/OpenSea listing orders to the Doma bulk listing API. Every order must already be valid and signed by the user's wallet.",
      inputSchema: z.object({
        orderbook: z.enum(["DOMA", "OPENSEA"]).default("DOMA"),
        chainId: z.string(),
        orders: z.array(z.record(z.string(), z.unknown())),
        cancelExisting: z.boolean().default(false),
        cancelSignatures: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (args) => {
        try {
          const { createDomaBulkListings } = await import("@/lib/doma");
          return await createDomaBulkListings(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_create_bulk_offers: tool({
      description: "Submit multiple signed Doma/OpenSea offer orders to the Doma bulk offer API. Every order must already be valid and signed by the user's wallet.",
      inputSchema: z.object({
        orderbook: z.enum(["DOMA", "OPENSEA"]).default("DOMA"),
        chainId: z.string(),
        orders: z.array(z.record(z.string(), z.unknown())),
        cancelExisting: z.boolean().default(false),
        cancelSignatures: z.record(z.string(), z.string()).optional(),
      }),
      execute: async (args) => {
        try {
          const { createDomaBulkOffers } = await import("@/lib/doma");
          return await createDomaBulkOffers(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_cancel_listing: tool({
      description: "Cancel a Doma marketplace listing using a signed cancellation authorization.",
      inputSchema: z.object({ orderId: z.string(), signature: z.string() }),
      execute: async (args) => {
        try {
          const { cancelDomaListing } = await import("@/lib/doma");
          return await cancelDomaListing(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_cancel_offer: tool({
      description: "Cancel a Doma marketplace offer using a signed cancellation authorization.",
      inputSchema: z.object({ orderId: z.string(), signature: z.string() }),
      execute: async (args) => {
        try {
          const { cancelDomaOffer } = await import("@/lib/doma");
          return await cancelDomaOffer(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_bulk_listing_items: tool({
      description: "Get paginated item status for a Doma bulk listing job.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        try {
          const { getDomaBulkListingItems } = await import("@/lib/doma");
          return await getDomaBulkListingItems(id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_get_bulk_offer_items: tool({
      description: "Get paginated item status for a Doma bulk offer job.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        try {
          const { getDomaBulkOfferItems } = await import("@/lib/doma");
          return await getDomaBulkOfferItems(id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_poll_events: tool({
      description: "Poll Doma Protocol events for tokenization, marketplace, and domain lifecycle changes.",
      inputSchema: z.object({
        cursor: z.string().optional(),
        limit: z.number().int().optional(),
        finalizedOnly: z.boolean().optional(),
        includeSynthetics: z.boolean().optional(),
        eventTypes: z.array(z.string()).optional(),
      }),
      execute: async (args) => {
        try {
          const { pollDomaEvents } = await import("@/lib/doma");
          return await pollDomaEvents(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_ack_events: tool({
      description: "Acknowledge processed Doma Poll API events up to lastEventId for a cursor.",
      inputSchema: z.object({ lastEventId: z.number().int(), cursor: z.string().optional() }),
      execute: async (args) => {
        try {
          const { acknowledgeDomaEvents } = await import("@/lib/doma");
          return await acknowledgeDomaEvents(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    doma_reset_event_cursor: tool({
      description: "Reset a Doma Poll API cursor to an earlier event id so events can be reprocessed.",
      inputSchema: z.object({ eventId: z.number().int(), cursor: z.string().optional() }),
      execute: async (args) => {
        try {
          const { resetDomaEventCursor } = await import("@/lib/doma");
          return await resetDomaEventCursor(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_payment_history: tool({
      description:
        "Fetch the user's full payment history from the database. Covers all transaction types: " +
        "'bill' (Bitrefill gift cards), 'investment' (stock/ETF purchases), " +
        "'nanopay' (Circle x402 payments), 'solpay' (Solana MPP payments), " +
        "'x402' (unified x402 payments), 'transfer' (USDC transfers), " +
        "'deposit' (Circle Gateway deposits), 'withdrawal' (Circle Gateway withdrawals), " +
        "'bridge' (Arc AppKit cross-chain bridges), " +
        "'onramp' (INR→crypto via UPI — starts pending, completed by webhook), " +
        "'offramp' (crypto→INR via bank — starts pending, completed by webhook). " +
        "A 'bill' record with chain='xrpl' is a \"pay with XRP\" purchase — describe it to the user only as paid with XRP, never mention swaps/bridges/NEAR Intents. " +
        "Each record includes chain ('evm'|'solana'|'xrpl'), amountUsdc, status, txHash, and createdAt.",
      inputSchema: z.object({
        limit: z
          .number()
          .optional()
          .describe("Number of records to return (default 20)"),
        type: z
          .enum(["bill", "investment", "nanopay", "solpay", "x402", "transfer", "deposit", "withdrawal", "bridge", "onramp", "offramp"])
          .optional()
          .describe("Filter by payment type"),
      }),
      execute: async ({ limit, type }) => {
        if (!userId) return { error: "Not authenticated" };
        try {
          const cap = Math.min(limit ?? 20, 100);
          const records = await db
            .select()
            .from(payments)
            .where(
              type
                ? and(eq(payments.userId, userId), eq(payments.type, type))
                : eq(payments.userId, userId),
            )
            .orderBy(desc(payments.createdAt))
            .limit(cap);

          return {
            payments: records.map((p) => ({
              id: p.id,
              type: p.type,
              description: p.description,
              amountUsdc: p.amountUsdc,
              status: p.status,
              chain: p.chain ?? "evm", // "evm" | "solana" — which network settled this payment
              createdAt: p.createdAt,
            })),
          };
        } catch (err: any) {
          return { error: err?.message || "Failed to fetch payment history" };
        }
      },
    }),

    // ── Balance history ───────────────────────────────────────────────────────

    get_balance_history: tool({
      description:
        "Fetch the user's wallet balance history from the database — periodic snapshots of EVM USDC, EVM USDT, Solana USDC, and Solana USDT balances. " +
        "Use to answer 'what was my balance last week?', show balance trends, or calculate net-worth change over time. " +
        "Returns snapshots newest-first. Each snapshot has evmUsdc, evmUsdt, solUsdc, solUsdt, totalUsdc, and createdAt.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional()
          .describe("Number of snapshots to return (default 50, max 500)"),
      }),
      execute: async ({ limit }) => {
        if (!userId) return { error: "Not authenticated" };
        try {
          const { balanceSnapshots: bsTable } = await import("@/lib/db/schema");
          const cap = Math.min(limit ?? 50, 500);
          const rows = await db
            .select()
            .from(bsTable)
            .where(eq(bsTable.userId, userId))
            .orderBy(desc(bsTable.createdAt))
            .limit(cap);
          return {
            snapshots: rows.map((r) => ({
              evmUsdc:   Number(r.evmUsdc),
              evmUsdt:   Number(r.evmUsdt),
              solUsdc:   Number(r.solUsdc),
              solUsdt:   Number(r.solUsdt),
              totalUsdc: Number(r.totalUsdc),
              createdAt: r.createdAt,
            })),
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch balance history" };
        }
      },
    }),

    // ── Bitrefill order history ───────────────────────────────────────────────

    get_bitrefill_orders: tool({
      description:
        "Fetch the user's Bitrefill order history from the database. " +
        "Each order includes invoiceId, productId, productName, packageValue, paymentMethod, " +
        "status (pending/complete/failed/expired), redemptionCode (once delivered), chain, and timestamps. " +
        "Use to answer 'show my gift card orders', 'did my Netflix purchase go through?', or look up a redemption code.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional()
          .describe("Number of orders to return (default 20, max 200)"),
        status: z.enum(["pending", "complete", "failed", "expired"]).optional()
          .describe("Filter by order status"),
      }),
      execute: async ({ limit, status }) => {
        if (!userId) return { error: "Not authenticated" };
        try {
          const cap = Math.min(limit ?? 20, 200);
          const rows = await db
            .select()
            .from(bitrefillOrders)
            .where(
              status
                ? and(eq(bitrefillOrders.userId, userId), eq(bitrefillOrders.status, status))
                : eq(bitrefillOrders.userId, userId),
            )
            .orderBy(desc(bitrefillOrders.createdAt))
            .limit(cap);
          return { orders: rows };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch Bitrefill orders" };
        }
      },
    }),

    // ── Circle Gateway Nanopayments ────────────────────────────────────────────

    get_nanopay_balance: tool({
      description:
        "Check the agent's Circle Gateway nanopayments balance on Base mainnet — both the wallet USDC balance and the spendable Gateway balance for gas-free payments.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const balances = await client.getBalances();
          return {
            address: client.address,
            wallet: { usdc: balances.wallet.formatted },
            gateway: {
              available: balances.gateway.formattedAvailable,
              total: balances.gateway.formattedTotal,
            },
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch balances" };
        }
      },
    }),

    nanopay_deposit: tool({
      description:
        "Deposit USDC from the agent wallet into the Circle Gateway balance so it can make gas-free nanopayments.",
      inputSchema: z.object({
        amount: z
          .string()
          .describe("Amount of USDC to deposit, e.g. '1' for 1 USDC"),
      }),
      execute: async ({ amount }) => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        const amountNum = Number(amount);
        if (isNaN(amountNum) || amountNum <= 0)
          return { error: "amount must be a positive number" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const balances = await client.getBalances();
          const needed = BigInt(Math.round(amountNum * 1_000_000));
          if (balances.gateway.available >= needed) {
            return {
              skipped: true,
              message: "Gateway balance already sufficient",
              gateway: { available: balances.gateway.formattedAvailable },
            };
          }
          const result = await client.deposit(String(amount));
          // Record gateway deposit in DB
          if (userId) {
            db.insert(payments).values({
              userId,
              type: "deposit",
              referenceId: result.depositTxHash ?? null,
              description: `Circle Gateway deposit: ${result.formattedAmount} USDC`,
              amountUsdc: String(amountNum),
              status: "completed",
              txHash: result.depositTxHash ?? null,
              chain: "evm",
            }).catch(() => {});
          }
          return {
            depositTxHash: result.depositTxHash,
            amount: result.formattedAmount,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Deposit failed" };
        }
      },
    }),

    nanopay_pay: tool({
      description:
        "Pay for an x402-protected resource using Circle Gateway nanopayments (gas-free USDC). " +
        "Before signing anything, the tool probes the seller's demanded price via supports() and enforces a spend ceiling (max_amount_usdc, default $0.10). " +
        "If the seller demands more than the ceiling, the tool returns { error: 'spend_limit_exceeded', demanded_usdc, max_amount_usdc } WITHOUT spending — " +
        "surface the demanded_usdc to the user and ask for explicit confirmation before retrying with max_amount_usdc set to the demanded amount. " +
        "On success, returns { status, data, paid, paid_usdc, transaction } — both the payment receipt and the unlocked resource content. " +
        "Accepts absolute URLs or relative paths like /api/nanopay/sell — relative paths are resolved against NEXT_PUBLIC_APP_URL.",
      inputSchema: z.object({
        url: z
          .string()
          .describe("Full URL or relative path of the x402-protected resource, e.g. /api/nanopay/sell or https://example.com/api/resource"),
        max_amount_usdc: z
          .number()
          .positive()
          .default(0.10)
          .describe("Spend ceiling in USDC. The tool aborts before signing if the seller demands more than this. Default $0.10. Always confirm with the user before setting above $1.00."),
      }),
      execute: async ({ url, max_amount_usdc }) => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        // Resolve relative paths to absolute URLs
        if (url.startsWith("/")) {
          const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
          url = base.replace(/\/$/, "") + url;
        }
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();

          // Probe: verify Gateway support AND read the demanded price before signing
          const support = await client.supports(url);
          if (!support.supported)
            return { error: "Target URL does not support Circle Gateway nanopayments" };

          // Enforce spend mandate — amount is in base units (6 decimals for USDC)
          const demandedBase = support.requirements?.amount;
          const demanded_usdc = demandedBase != null ? Number(demandedBase) / 1_000_000 : null;
          if (demanded_usdc !== null && demanded_usdc > max_amount_usdc) {
            return {
              error: "spend_limit_exceeded",
              demanded_usdc,
              max_amount_usdc,
              message: `Seller demands $${demanded_usdc} USDC but spend ceiling is $${max_amount_usdc} USDC. Confirm with the user, then retry with max_amount_usdc set to ${demanded_usdc}.`,
            };
          }

          // Backstop hook: enforce the same ceiling inside pay() as a second-layer defence
          // against race conditions where supports() and pay() could see different requirements.
          const ceiling = max_amount_usdc;
          client.onBeforePaymentCreation(async (ctx) => {
            const payAmount = Number(ctx.selectedRequirements.amount) / 1_000_000;
            if (payAmount > ceiling) {
              return { abort: true, reason: `Payment of $${payAmount} USDC exceeds spend ceiling of $${ceiling} USDC` };
            }
          });

          const { data, status, formattedAmount, transaction, amount } = await client.pay(url);
          const paidUsdc = Number(amount) / 1_000_000;
          // Record nanopayment in DB
          if (userId) {
            db.insert(payments).values({
              userId,
              type: "nanopay",
              referenceId: transaction ?? null,
              description: `Circle nanopayment: ${url}`,
              amountUsdc: String(paidUsdc),
              status: "completed",
              txHash: transaction ?? null,
              chain: "evm",
            }).catch(() => {});
          }
          return {
            status,
            data,
            paid: formattedAmount,
            paid_usdc: paidUsdc,
            transaction,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Payment failed" };
        }
      },
    }),

    nanopay_withdraw: tool({
      description:
        "Withdraw USDC from the Circle Gateway balance back to the agent wallet on Base mainnet.",
      inputSchema: z.object({
        amount: z
          .string()
          .describe("Amount of USDC to withdraw, e.g. '0.5' for 0.5 USDC"),
      }),
      execute: async ({ amount }) => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        const amountNum = Number(amount);
        if (isNaN(amountNum) || amountNum <= 0)
          return { error: "amount must be a positive number" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const result = await client.withdraw(String(amount));
          // Record gateway withdrawal in DB
          if (userId) {
            db.insert(payments).values({
              userId,
              type: "withdrawal",
              referenceId: result.mintTxHash ?? null,
              description: `Circle Gateway withdrawal: ${result.formattedAmount} USDC`,
              amountUsdc: String(amountNum),
              status: "completed",
              txHash: result.mintTxHash ?? null,
              chain: "evm",
            }).catch(() => {});
          }
          return {
            mintTxHash: result.mintTxHash,
            amount: result.formattedAmount,
            chain: result.destinationChain,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Withdrawal failed" };
        }
      },
    }),

    nanopay_transfer: tool({
      description:
        "Transfer USDC from the agent's Circle Gateway balance to any wallet address on any supported chain (Base, Ethereum, Arbitrum, Polygon, Optimism, etc.). Circle batches the settlement so neither party pays gas. Use this for agent-to-agent or agent-to-user USDC transfers.",
      inputSchema: z.object({
        amount: z.string().describe("Amount of USDC to send, e.g. '0.50'"),
        recipient: z.string().describe("Destination wallet address"),
        chain: z.string().default("base").describe("Destination chain name: 'base', 'ethereum', 'arbitrum', 'polygon', 'optimism', etc."),
      }),
      execute: async ({ amount, recipient, chain }) => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        const amountNum = Number(amount);
        if (isNaN(amountNum) || amountNum <= 0)
          return { error: "amount must be a positive number" };
        try {
          // Call SDK directly — avoids the auth round-trip to /api/nanopay/transfer
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const result = await client.transfer(
            String(amount),
            (chain ?? "base") as Parameters<typeof client.transfer>[1],
            recipient as `0x${string}`,
          );
          // Record Circle transfer in DB
          if (userId) {
            db.insert(payments).values({
              userId,
              type: "transfer",
              referenceId: result.mintTxHash ?? null,
              description: `Circle Gateway transfer: ${amount} USDC → ${recipient} (${chain ?? "base"})`,
              amountUsdc: String(amountNum),
              status: "completed",
              txHash: result.mintTxHash ?? null,
              chain: "evm",
            }).catch(() => {});
          }
          return {
            txHash: result.mintTxHash,
            amount: result.formattedAmount,
            recipient,
            chain: result.destinationChain ?? chain ?? "base",
          };
        } catch (err: any) {
          return { error: err?.message ?? "Transfer failed" };
        }
      },
    }),

    nanopay_get_transfer: tool({
      description: "Look up the status and details of a specific Circle Gateway transfer by its transfer ID. Use after nanopay_transfer to confirm delivery.",
      inputSchema: z.object({
        transferId: z.string().describe("Transfer ID returned from a previous nanopay_transfer call"),
      }),
      execute: async ({ transferId }) => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          return await (client as any).getTransferById(transferId);
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch transfer" };
        }
      },
    }),

    nanopay_search_transfers: tool({
      description: "Search Circle Gateway transfer history. Filter by sender address, recipient address, status, or date range. Useful for reviewing past nanopayments and transfers.",
      inputSchema: z.object({
        from: z.string().optional().describe("Filter by sender wallet address"),
        to: z.string().optional().describe("Filter by recipient wallet address"),
        status: z.string().optional().describe("Filter by status, e.g. 'completed', 'pending', 'failed'"),
        startDate: z.string().optional().describe("ISO date string, e.g. '2025-01-01'"),
        endDate: z.string().optional().describe("ISO date string, e.g. '2025-12-31'"),
      }),
      execute: async ({ from, to, status, startDate, endDate }) => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const params: Record<string, string> = {};
          if (from) params.from = from;
          if (to) params.to = to;
          if (status) params.status = status;
          if (startDate) params.startDate = startDate;
          if (endDate) params.endDate = endDate;
          return await (client as any).searchTransfers(params);
        } catch (err: any) {
          return { error: err?.message ?? "Failed to search transfers" };
        }
      },
    }),

    nanopay_deposit_for: tool({
      description:
        "Deposit USDC from the agent's Circle Gateway balance into another EVM address's Gateway balance. " +
        "Useful for funding a user's or another agent's gateway so they can make gas-free payments without doing it themselves.",
      inputSchema: z.object({
        amount: z.string().describe("Amount of USDC to deposit, e.g. '1.00'"),
        depositor: z.string().describe("EVM address whose Gateway balance to fund"),
      }),
      execute: async ({ amount, depositor }) => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        const amountNum = Number(amount);
        if (isNaN(amountNum) || amountNum <= 0) return { error: "amount must be a positive number" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const result = await client.depositFor(String(amount), depositor as `0x${string}`);
          if (userId) {
            db.insert(payments).values({
              userId,
              type: "deposit",
              referenceId: result.depositTxHash ?? null,
              description: `Circle Gateway depositFor: ${amount} USDC → ${depositor}`,
              amountUsdc: String(amountNum),
              status: "completed",
              txHash: result.depositTxHash ?? null,
              chain: "evm",
            }).catch(() => {});
          }
          return {
            ...(result.approvalTxHash ? { approvalTxHash: result.approvalTxHash } : {}),
            depositTxHash: result.depositTxHash,
            amount: result.formattedAmount,
            depositor,
          };
        } catch (err: any) { return { error: err?.message ?? "depositFor failed" }; }
      },
    }),

    nanopay_trustless_withdrawal_status: tool({
      description:
        "Check the current trustless withdrawal state for the agent's Circle Gateway balance — " +
        "shows delay period in blocks, the block at which withdrawal becomes claimable, and the withdrawable/available USDC amounts. " +
        "Call this before initiating or completing a trustless withdrawal.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const [delay, block, balance] = await Promise.all([
            client.getTrustlessWithdrawalDelay(),
            client.getTrustlessWithdrawalBlock(),
            client.getBalance(),
          ]);
          return {
            delayBlocks: delay.toString(),
            withdrawalAvailableAtBlock: block.toString(),
            withdrawableUsdc: (balance as any).formattedWithdrawable ?? null,
            availableUsdc: (balance as any).formattedAvailable ?? null,
          };
        } catch (err: any) { return { error: err?.message ?? "Failed to fetch withdrawal state" }; }
      },
    }),

    nanopay_initiate_trustless_withdrawal: tool({
      description:
        "Phase 1 of a trustless (facilitator-independent) withdrawal from Circle Gateway. " +
        "Locks the specified USDC amount on-chain; after the delay period passes, call nanopay_complete_trustless_withdrawal to claim. " +
        "Use this when the normal nanopay_withdraw is unavailable or Circle facilitator is unresponsive.",
      inputSchema: z.object({
        amount: z.string().describe("Amount of USDC to withdraw trustlessly, e.g. '5.00'"),
      }),
      execute: async ({ amount }) => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        const amountNum = Number(amount);
        if (isNaN(amountNum) || amountNum <= 0) return { error: "amount must be a positive number" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const result = await client.initiateTrustlessWithdrawal(String(amount));
          if (userId) {
            db.insert(payments).values({
              userId,
              type: "withdrawal",
              referenceId: result.txHash ?? null,
              description: `Circle trustless withdrawal initiated: ${amount} USDC`,
              amountUsdc: String(amountNum),
              status: "pending",
              txHash: result.txHash ?? null,
              chain: "evm",
            }).catch(() => {});
          }
          return {
            action: "initiated",
            txHash: result.txHash,
            amount: result.formattedAmount,
            withdrawalAvailableAtBlock: (result as any).withdrawalBlock?.toString() ?? null,
            note: "Call nanopay_complete_trustless_withdrawal once the current block exceeds withdrawalAvailableAtBlock",
          };
        } catch (err: any) { return { error: err?.message ?? "Initiate trustless withdrawal failed" }; }
      },
    }),

    nanopay_complete_trustless_withdrawal: tool({
      description:
        "Phase 2 of a trustless withdrawal — claims the USDC locked by nanopay_initiate_trustless_withdrawal after the required block delay. " +
        "Check nanopay_trustless_withdrawal_status first to confirm the delay has passed.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        try {
          const { getBuyerClient } = await import("@/lib/circle-gateway");
          const client = getBuyerClient();
          const result = await client.completeTrustlessWithdrawal();
          if (userId) {
            db.insert(payments).values({
              userId,
              type: "withdrawal",
              referenceId: result.txHash ?? null,
              description: `Circle trustless withdrawal completed: ${result.formattedAmount} USDC`,
              amountUsdc: String(result.formattedAmount ?? "0"),
              status: "completed",
              txHash: result.txHash ?? null,
              chain: "evm",
            }).catch(() => {});
          }
          return {
            action: "completed",
            txHash: result.txHash,
            amount: result.formattedAmount,
          };
        } catch (err: any) { return { error: err?.message ?? "Complete trustless withdrawal failed" }; }
      },
    }),

    nanopay_get_supported: tool({
      description:
        "Query which x402 payment schemes the Circle facilitator currently supports. " +
        "Useful for diagnostics — confirms the facilitator is reachable and shows supported scheme versions.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!process.env.CIRCLE_BUYER_PRIVATE_KEY)
          return { error: "CIRCLE_BUYER_PRIVATE_KEY not configured" };
        try {
          const { getFacilitatorClient } = await import("@/lib/circle-gateway");
          const facilitator = getFacilitatorClient();
          const supported = await facilitator.getSupported();
          return supported;
        } catch (err: any) { return { error: err?.message ?? "Failed to fetch supported schemes" }; }
      },
    }),

    nanopay_sell: tool({
      description:
        "Access the Circle Gateway nanopayment-protected seller endpoint (GET /api/nanopay/sell). " +
        "Returns premium content after the caller pays $0.000001 USDC (Circle protocol minimum) via the x402 protocol on Base mainnet. " +
        "Without a valid PAYMENT-SIGNATURE header the endpoint issues a 402 Payment Required response. " +
        "Use nanopay_pay to pay for this endpoint, or call directly to inspect the 402 challenge.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/nanopay/sell`);
          const data = await r.json().catch(() => ({}));
          if (r.status === 402) return { status: "payment_required", price_usd: 0.01, chain: "Base", note: "Use nanopay_pay to purchase access to this endpoint." };
          if (!r.ok) return { error: (data as any)?.error ?? "Failed" };
          return data;
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── Solana Nanopayments (x402 / MPP via @solana/pay-kit) ─────────────────

    get_solpay_balance: tool({
      description:
        "Check the agent's Solana nanopayment wallet balance (SOL and USDC on Solana mainnet). This is a dedicated server wallet separate from the user's Solana wallet.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!process.env.SOLANA_AGENT_PRIVATE_KEY)
          return { error: "SOLANA_AGENT_PRIVATE_KEY not configured" };
        try {
          const { getSolPayBalance } = await import("@/lib/solana-pay-kit");
          return await getSolPayBalance();
        } catch (err: any) { return { error: err?.message ?? "Failed to fetch balance" }; }
      },
    }),

    solpay_transfer: tool({
      description:
        "Transfer USDC from the agent's Solana wallet to any Solana address. " +
        "Uses the on-chain SPL token program — requires SOL in the agent wallet for transaction fees. " +
        "Returns the transaction signature on success.",
      inputSchema: z.object({
        toAddress: z.string().describe("Destination Solana wallet address (base58)"),
        amountUsdc: z.number().positive().describe("Amount of USDC to send, e.g. 0.5 for 0.5 USDC"),
      }),
      execute: async ({ toAddress, amountUsdc }) => {
        if (!process.env.SOLANA_AGENT_PRIVATE_KEY)
          return { error: "SOLANA_AGENT_PRIVATE_KEY not configured" };
        try {
          const { solPayTransfer } = await import("@/lib/solana-pay-kit");
          const result = await solPayTransfer(toAddress, amountUsdc);
          // Record Solana transfer in DB
          if (userId) {
            db.insert(payments).values({
              userId,
              type: "transfer",
              referenceId: result.txSignature,
              description: `Solana USDC transfer: ${amountUsdc} USDC → ${toAddress}`,
              amountUsdc: String(amountUsdc),
              status: "completed",
              txHash: result.txSignature,
              chain: "solana",
            }).catch(() => {});
          }
          return result;
        } catch (err: any) { return { error: err?.message ?? "Transfer failed" }; }
      },
    }),

    solpay_sell_dynamic: tool({
      description:
        "Trigger the SolPay dynamic-priced gate — lets the caller request content at a variable per-request USDC price. " +
        "If the request has not been pre-paid the endpoint issues a 402 challenge; once the user pays on-chain the content is returned. " +
        "Pass a price in USDC to override the default ($0.01). " +
        "Use when you need a flexible one-off payment at a caller-specified price.",
      inputSchema: z.object({
        price: z.number().positive().optional().describe("Price in USDC for this request, e.g. 0.05. Defaults to 0.01."),
      }),
      execute: async ({ price }) => {
        try {
          const params = new URLSearchParams();
          if (price !== undefined) params.set("price", String(price));
          const r = await fetch(`${appBase()}/api/solpay/sell-dynamic?${params}`);
          const data = await r.json();
          if (r.status === 402) return { status: "payment_required", challenge: data };
          if (!r.ok) return { error: data?.error ?? "Failed" };
          return data;
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    solpay_sell_subscription: tool({
      description:
        "Check if the user has an active SolPay weekly subscription and serve gated content. " +
        "Non-subscribers receive a 402 MPP subscription challenge; active subscribers get the content immediately. " +
        "Plan: bluvfi-weekly-v1 at $0.25 USDC/week. " +
        "Use when you want to verify a recurring subscriber before delivering premium content.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/solpay/sell-subscription`);
          const data = await r.json();
          if (r.status === 402) return { status: "payment_required", challenge: data };
          if (!r.ok) return { error: data?.error ?? "Failed" };
          return data;
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    solpay_sell_usage: tool({
      description:
        "Submit text to the SolPay metered usage gate — charges $0.001 USDC per word up to $0.10 max. " +
        "If unpaid, returns a 402 x402 challenge. When paid, returns the processed text (uppercased), word count, and exact amount charged. " +
        "Use to demonstrate metered per-word billing on Solana.",
      inputSchema: z.object({
        text: z.string().describe("Text to process. Charged at $0.001 USDC per word, capped at $0.10."),
      }),
      execute: async ({ text }) => {
        try {
          const r = await fetch(`${appBase()}/api/solpay/sell-usage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          const data = await r.json();
          if (r.status === 402) return { status: "payment_required", challenge: data };
          if (!r.ok) return { error: data?.error ?? "Failed" };
          return data;
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    solpay_sell_with_fee: tool({
      description:
        "Trigger the SolPay fee-split gate — charges $0.011 USDC total: $0.010 to the seller and $0.001 to the platform fee recipient. " +
        "Returns payment confirmation and fee breakdown once paid. " +
        "Requires SOLANA_FEE_RECIPIENT to be configured. " +
        "Use to demonstrate atomic on-chain fee splitting with MPP.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/solpay/sell-with-fee`);
          const data = await r.json();
          if (r.status === 402) return { status: "payment_required", challenge: data };
          if (!r.ok) return { error: data?.error ?? "Failed" };
          return data;
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    solana_transfer_usdc: tool({
      description:
        "Build an unsigned Solana USDC transfer transaction from the user's wallet to the app's receiver address. " +
        "Returns a base64-encoded serialized transaction that the user must sign with their Privy Solana wallet. " +
        "The user signs client-side — this tool only builds the transaction, it does NOT broadcast it. " +
        "Use when a bill or investment payment needs to be sent on Solana.",
      inputSchema: z.object({
        from: z.string().describe("User's Solana wallet address (base58)"),
        amountUsdc: z.number().positive().describe("Amount of USDC to transfer (e.g. 1.5 for $1.50)"),
      }),
      execute: async ({ from, amountUsdc }) => {
        // Build unsigned Solana USDC transfer directly — avoids auth round-trip to /api/solana/transfer-usdc
        const receiver = process.env.SOLANA_BILL_RECEIVER;
        if (!receiver) return { error: "SOLANA_BILL_RECEIVER not configured" };
        if (amountUsdc < 0.000001) return { error: "amountUsdc must be ≥ $0.000001" };
        try {
          const { Connection, PublicKey, Transaction, Keypair } = await import("@solana/web3.js");
          const { getOrCreateAssociatedTokenAccount, createTransferInstruction, getAssociatedTokenAddress } = await import("@solana/spl-token");
          const bs58 = (await import("bs58")).default;
          const SOLANA_RPC =
            process.env.FLASH_SOLANA_RPC ||
            `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}` ||
            "https://api.mainnet-beta.solana.com";
          const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
          const agentKey = process.env.SOLANA_AGENT_PRIVATE_KEY;
          const payer = agentKey ? Keypair.fromSecretKey(bs58.decode(agentKey)) : null;
          const connection = new Connection(SOLANA_RPC, "confirmed");
          const usdcMint = new PublicKey(USDC_MINT);
          const fromPubkey = new PublicKey(from);
          const toPubkey = new PublicKey(receiver);
          const [fromAta, toAta] = payer
            ? await Promise.all([
                getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, fromPubkey),
                getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, toPubkey),
              ])
            : await Promise.all([
                getAssociatedTokenAddress(usdcMint, fromPubkey).then((a) => ({ address: a })),
                getAssociatedTokenAddress(usdcMint, toPubkey).then((a) => ({ address: a })),
              ]);
          const baseUnits = BigInt(Math.round(amountUsdc * 1_000_000));
          const ix = createTransferInstruction(fromAta.address, toAta.address, fromPubkey, baseUnits);
          const { blockhash } = await connection.getLatestBlockhash();
          const tx = new Transaction({ recentBlockhash: blockhash, feePayer: fromPubkey }).add(ix);
          const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
          return { transaction: serialized.toString("base64"), note: "Transaction built. The user must sign this base64 transaction with their Privy Solana wallet client-side, then broadcast it." };
        } catch (err: any) { return { error: err?.message ?? "Failed to build transaction" }; }
      },
    }),

    solpay_get_transaction: tool({
      description:
        "Look up a specific Solana transaction by its signature. Returns block time, SOL fee, error status, and USDC token balance changes for the agent wallet. Use after solpay_transfer or solpay_pay to confirm delivery.",
      inputSchema: z.object({
        signature: z.string().describe("Solana transaction signature (base58)"),
      }),
      execute: async ({ signature }) => {
        if (!process.env.SOLANA_AGENT_PRIVATE_KEY)
          return { error: "SOLANA_AGENT_PRIVATE_KEY not configured" };
        try {
          const { getSolPayTransaction } = await import("@/lib/solana-pay-kit");
          return await getSolPayTransaction(signature);
        } catch (err: any) { return { error: err?.message ?? "Failed to fetch transaction" }; }
      },
    }),

    solpay_search_transactions: tool({
      description:
        "List recent Solana transactions for the agent wallet — shows signatures, timestamps, and error status. " +
        "Use to review recent nanopayment and transfer history. Pass 'before' (a signature) to paginate.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe("Number of transactions to return (default 20, max 100)"),
        before: z.string().optional().describe("Paginate backwards from this transaction signature"),
      }),
      execute: async ({ limit, before }) => {
        if (!process.env.SOLANA_AGENT_PRIVATE_KEY)
          return { error: "SOLANA_AGENT_PRIVATE_KEY not configured" };
        try {
          const { searchSolPayTransactions } = await import("@/lib/solana-pay-kit");
          return await searchSolPayTransactions({ limit, before });
        } catch (err: any) { return { error: err?.message ?? "Failed to fetch transactions" }; }
      },
    }),

    solpay_pay: tool({
      description:
        "Fetch an x402 or MPP-protected URL using the agent's Solana wallet (USDC on Solana mainnet). " +
        "Works for all gate types — charge (fixed price), usage (metered), and subscription (recurring). " +
        "The SDK detects the gate type from the server's 402 challenge automatically. " +
        "For usage gates (POST), pass a JSON body via the body field. " +
        "Returns { status, data, paid, error? }.",
      inputSchema: z.object({
        url: z.string().describe("Full URL of the protected resource. Relative URLs like /api/solpay/sell are also accepted."),
        method: z.enum(["GET", "POST"]).optional().default("GET").describe("HTTP method — use POST for usage-gated endpoints"),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON body for POST requests (e.g. { text: 'hello world' } for usage gates)"),
      }),
      execute: async ({ url, method = "GET", body }) => {
        if (!process.env.SOLANA_AGENT_PRIVATE_KEY)
          return { error: "SOLANA_AGENT_PRIVATE_KEY not configured" };
        try {
          const { solPayFetch } = await import("@/lib/solana-pay-kit");
          const result = await solPayFetch(url, (method ?? "GET") as "GET" | "POST", body);
          // Record Solana nanopayment in DB when payment was made (paid=true, no error)
          if (userId && result.paid && !result.error) {
            // Extract amount from data payload if present (usage gates return chargedUSDC)
            const dataAny = result.data as Record<string, unknown> | null;
            const paidUsdc = dataAny?.chargedUSDC ?? dataAny?.priceUSDC ?? "0";
            const txSig = dataAny?.txSignature ?? dataAny?.signature ?? null;
            db.insert(payments).values({
              userId,
              type: "solpay",
              referenceId: txSig != null ? String(txSig) : null,
              description: `Solana nanopayment: ${url}`,
              amountUsdc: String(paidUsdc),
              status: "completed",
              txHash: txSig != null ? String(txSig) : null,
              chain: "solana",
            }).catch(() => {});
          }
          return result;
        } catch (err: any) { return { error: err?.message ?? "Payment failed" }; }
      },
    }),

    // ── Unified x402 payment (EVM + Solana, multi-offer, CAIP-2, capped) ────────

    x402_pay: tool({
      description:
        "Unified x402 payment tool — handles 402 responses that offer multiple networks and tokens. " +
        "Supported EVM networks (USDC + USDT): Base (eip155:8453), Arbitrum (eip155:42161), Optimism (eip155:10), Polygon (eip155:137), Avalanche (eip155:43114), Ethereum (eip155:1). " +
        "Supported Solana network (USDC + USDT + PYUSD + USDG + CASH): solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp. " +
        "Selection priority: Base USDC > Base USDT > Solana USDC > Solana USDT > Arbitrum/Optimism > Polygon/Avalanche > Ethereum. " +
        "Flow: (1) probe the URL, parse accepts[] from the 402 body; (2) select the best offer (CAIP-2 match + price cap + token preference); " +
        "(3) enforce max_amount_usdc cap — abort before signing if any offer demands more; " +
        "(4) pay: Base → Circle Gateway (gasless); other EVM → viem ERC-20 transfer + tx hash credential; Solana → pay-kit MPP/x402; " +
        "(5) retry once on transient errors (timeout, RPC, network); " +
        "(6) return a unified receipt: { success, network, paid_usdc, tx, data }. " +
        "Use this instead of nanopay_pay / solpay_pay when the resource offers both EVM and Solana payment options. " +
        "Minimum payment is $0.000001 USDC. Default cap is $0.002 USDC — always confirm with the user before raising above $1.00.",
      inputSchema: z.object({
        url: z
          .string()
          .describe("Full URL or relative path of the x402-protected resource"),
        preferred_network: z
          .string()
          .optional()
          .describe(
            "Exact CAIP-2 network to restrict to, e.g. 'eip155:8453' (Base), 'eip155:42161' (Arbitrum), " +
            "'eip155:10' (Optimism), 'eip155:137' (Polygon), 'eip155:43114' (Avalanche), 'eip155:1' (Ethereum), " +
            "or 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' (Solana). " +
            "Omit to auto-select by highest score (Base USDC preferred).",
          ),
        max_amount_usdc: z
          .number()
          .positive()
          .default(0.002)
          .describe("Hard spend ceiling in USDC (default $0.002). Aborts before signing if the offer demands more. Confirm with user before raising above $1.00."),
        method: z
          .enum(["GET", "POST"])
          .optional()
          .default("GET")
          .describe("HTTP method — use POST for usage-metered endpoints"),
        body: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON body for POST requests"),
      }),
      execute: async ({ url, preferred_network, max_amount_usdc, method = "GET", body }) => {
        // Call consume402 directly — avoids the auth round-trip to /api/x402/consume.
        // consume402 owns all 402 parsing, CAIP-2 validation, price-cap enforcement,
        // sign-once + retry-once logic, and Base-preferred / Solana-fallback selection.
        try {
          const { consume402, ALLOWED_NETWORKS, DEFAULT_MAX_PRICE_USD } = await import("@/lib/x402-consumer");

          // If preferred_network is supplied it becomes a single-item allowlist,
          // enforcing exact CAIP-2 match. Otherwise all supported networks are tried.
          const allowedNetworks = preferred_network
            ? new Set([preferred_network])
            : ALLOWED_NETWORKS;

          let payload: Record<string, unknown>;
          try {
            const result = await consume402({
              url,
              method: (method ?? "GET") as "GET" | "POST",
              body,
              maxPriceUsd: max_amount_usdc ?? DEFAULT_MAX_PRICE_USD,
              allowedNetworks,
            });
            payload = result as unknown as Record<string, unknown>;
          } catch (consumeErr: unknown) {
            const msg = (consumeErr instanceof Error ? consumeErr.message : String(consumeErr)) ?? "consume402 failed";
            if (msg.includes("No acceptable offer")) {
              return {
                error: "spend_limit_exceeded",
                message: msg,
                tip: `Raise max_amount_usdc above $${max_amount_usdc ?? 0.002} or choose a cheaper network.`,
              };
            }
            return { error: msg };
          }

          // payload shape: { receipt: ConsumeReceipt, result: any, status: number }
          const receipt = payload.receipt as Record<string, unknown> | undefined;
          const paidUsdc = receipt?.amountUSDC ?? 0;
          const network  = receipt?.network ?? null;
          // Record unified x402 payment in DB
          if (userId && receipt) {
            const isEvm = typeof network === "string" && network.startsWith("eip155");
            const ref = receipt?.reference ? String(receipt.reference) : null;
            db.insert(payments).values({
              userId,
              type: "x402",
              referenceId: ref,
              description: `x402 payment: ${url}`,
              amountUsdc: String(paidUsdc),
              status: "completed",
              txHash: ref,
              chain: isEvm ? "evm" : "solana",
            }).catch(() => {});
          }
          return {
            success: true,
            network,
            paid_usdc: paidUsdc,
            tx: receipt?.reference ?? null,
            payer: receipt?.payer ?? null,
            retried: receipt?.retried ?? false,
            data: payload.result,
            status: payload.status,
            receipt,
          };
        } catch (err: unknown) {
          return { error: (err instanceof Error ? err.message : String(err)) ?? "x402_pay failed" };
        }
      },
    }),

    // ── Banking — Onramp (INR → Crypto) ──────────────────────────────────────

    get_onramp_pairs: tool({
      description:
        "List all available INR-to-crypto currency pairs for onramping (buying crypto with UPI). Returns pair IDs, blockchains, fee info, min/max amounts, and processing times.",
      inputSchema: z.object({}),
      execute: async () => {
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.getOnrampPairs();
          return { pairs: result.data ?? [] };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to load pairs" };
        }
      },
    }),

    get_onramp_quote: tool({
      description:
        "Get a live INR quote for buying crypto via UPI onramp. Returns the rate, platform fee, network fee, and total INR to pay. Call this before creating an order so the user can see the cost.",
      inputSchema: z.object({
        pair_id: z.string().describe("Currency pair ID from get_onramp_pairs, e.g. 'inr-usdt-solana'"),
        amount: z.number().positive().describe("Crypto amount the user wants to receive, in output currency units (e.g. 50 USDT)"),
      }),
      execute: async ({ pair_id, amount }) => {
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.getOnrampRate(pair_id, amount);
          const q = result.data;
          return {
            rate_inr_per_unit: q.rate,
            platform_fee_inr: q.fee_input,
            network_fee_inr: q.network_fee_input,
            total_inr_to_pay: Math.round(amount * q.rate + q.fee_input + q.network_fee_input),
            expires_at: q.expires_at,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch quote" };
        }
      },
    }),

    create_onramp_order: tool({
      description:
        "Create an onramp order so the user can buy crypto by paying INR via UPI. Only call this when the user explicitly confirms they want to proceed. Returns a UPI payment link the user can open in their UPI app, plus the order ID to track status.",
      inputSchema: z.object({
        pair_id: z.string().describe("Currency pair ID from get_onramp_pairs"),
        amount: z.number().positive().describe("Crypto amount to receive (in output currency units)"),
        first_name: z.string().describe("Customer first name"),
        last_name: z.string().describe("Customer last name"),
        blockchain: z.string().describe("Blockchain for this pair (e.g. 'solana', 'ethereum') — used to auto-select the right wallet"),
        destination_address: z.string().optional().describe("Override wallet address — leave blank to auto-use the user's wallet for the given blockchain"),
      }),
      execute: async ({ pair_id, amount, first_name, last_name, blockchain, destination_address }) => {
        if (!userId) return { error: "Not authenticated" };
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        const dest = destination_address?.trim() || addressFor(blockchain);
        if (!dest) return { error: "No wallet address available for this network. Ask the user to provide one." };
        try {
          const result = await provider.createOnrampOrder({ pair_id, amount, customer_id: userId, first_name, last_name, destination_address: dest });
          const o = result.data;
          // Persist pending onramp order — webhook marks completed when crypto arrives
          db.insert(payments).values({
            userId,
            type: "onramp",
            referenceId: o.order_id ? String(o.order_id) : null,
            description: `UPI onramp: ${amount} ${pair_id} → ${dest.slice(0, 8)}…`,
            amountUsdc: String(o.output_amount ?? amount),
            status: "pending",
            chain: blockchain?.startsWith("solana") ? "solana" : "evm",
          }).catch(() => {});
          return {
            order_id: o.order_id,
            upi_link: o.upi_intent,
            total_inr_to_pay: o.input_amount,
            rate: o.rate,
            expires_at: o.expires_at,
            instruction: `Open the UPI link in any UPI app (GPay, PhonePe, Paytm) to complete payment. Order ID: ${o.order_id}`,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to create order" };
        }
      },
    }),

    get_onramp_order: tool({
      description: "Check the current status of a specific onramp order by order ID.",
      inputSchema: z.object({
        order_id: z.string().describe("The onramp order ID to look up"),
      }),
      execute: async ({ order_id }) => {
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.getOnrampOrder(order_id);
          const o = result.data;
          return {
            order_id: o.order_id,
            status: o.status,
            input_amount_inr: o.input_amount,
            output_amount: o.output_amount,
            output_currency: o.output_currency,
            destination_address: o.destination_address,
            created_at: o.created_at,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch order" };
        }
      },
    }),

    list_onramp_orders: tool({
      description: "List the user's recent onramp (buy crypto with UPI) orders with their statuses.",
      inputSchema: z.object({
        page: z.number().int().min(0).optional().describe("Page number for pagination (default 0)"),
        limit: z.number().optional().describe("Number of orders to return (default 10)"),
        status: z.string().optional().describe("Filter by status: CREATED, PAYMENT_PENDING, PAYMENT_RECEIVED, WITHDRAWAL_INITIATED, CONFIRMATIONS_PENDING, COMPLETED, EXPIRED, FAILED"),
      }),
      execute: async ({ page, limit, status }) => {
        if (!userId) return { error: "Not authenticated" };
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.listOnrampOrders({ page: page ?? 0, limit: limit ?? 10, status, customer_id: userId });
          return {
            orders: (result.data ?? []).map((o: any) => ({
              order_id: o.order_id,
              status: o.status,
              input_amount_inr: o.input_amount,
              output_amount: o.output_amount,
              output_currency: o.output_currency,
              created_at: o.created_at,
            })),
            total: result.totalCount ?? 0,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to list orders" };
        }
      },
    }),

    // ── Banking — Offramp (Crypto → INR) ──────────────────────────────────────

    get_offramp_pairs: tool({
      description:
        "List all available crypto-to-INR currency pairs for offramping (selling crypto for INR). Returns pair IDs, blockchains, fee info, min/max amounts, and processing times.",
      inputSchema: z.object({}),
      execute: async () => {
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.getOfframpPairs();
          return { pairs: result.data ?? [] };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to load pairs" };
        }
      },
    }),

    get_offramp_quote: tool({
      description:
        "Get a live INR quote for selling crypto via offramp. Returns the rate, fees, and estimated INR the user will receive. Call this before creating an order.",
      inputSchema: z.object({
        pair_id: z.string().describe("Currency pair ID from get_offramp_pairs, e.g. 'usdt-inr-solana'"),
        amount: z.number().positive().describe("Crypto amount to sell, in input currency units (e.g. 50 USDT)"),
      }),
      execute: async ({ pair_id, amount }) => {
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.getOfframpRate(pair_id, amount);
          const q = result.data;
          return {
            rate_inr_per_unit: q.rate,
            platform_fee_inr: q.fee_input,
            network_fee_inr: q.network_fee_input,
            estimated_inr_received: Math.max(0, Math.round(amount * q.rate - q.fee_input - q.network_fee_input)),
            expires_at: q.expires_at,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch quote" };
        }
      },
    }),

    get_offramp_bank_accounts: tool({
      description: "List the user's saved INR payout bank accounts for offramping. Returns bank name, masked account number, IFSC, and account holder name.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!userId) return { error: "Not authenticated" };
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.listBankAccounts(userId);
          return { bank_accounts: result.data ?? [] };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to load bank accounts" };
        }
      },
    }),

    add_offramp_bank_account: tool({
      description:
        "Add a new INR payout bank account for the user. Credible verifies it via penny-drop. Only call when the user explicitly provides their account details and wants to add it.",
      inputSchema: z.object({
        first_name: z.string().describe("Account holder first name"),
        last_name: z.string().describe("Account holder last name"),
        account_number: z.string().describe("Bank account number"),
        ifsc: z.string().describe("Bank branch IFSC code, e.g. HDFC0001234"),
      }),
      execute: async ({ first_name, last_name, account_number, ifsc }) => {
        if (!userId) return { error: "Not authenticated" };
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.addBankAccount({ customer_id: userId, first_name, last_name, account_number, ifsc });
          const a = result.data;
          return {
            bank_account_id: a.bank_account_id,
            bank_name: a.bank_name,
            account_number: a.account_number,
            account_holder_name: a.account_holder_name,
            ifsc: a.ifsc,
            verified: true,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to add bank account" };
        }
      },
    }),

    create_offramp_order: tool({
      description:
        "Create an offramp order so the user can sell crypto and receive INR in their bank account. Only call when the user explicitly confirms. Returns a deposit address — the user sends crypto there and INR lands in their bank.",
      inputSchema: z.object({
        pair_id: z.string().describe("Currency pair ID from get_offramp_pairs"),
        amount: z.number().positive().describe("Crypto amount to sell (in input currency units)"),
        first_name: z.string().describe("Customer first name"),
        last_name: z.string().describe("Customer last name"),
        bank_account_id: z.string().describe("Bank account ID from get_offramp_bank_accounts"),
      }),
      execute: async ({ pair_id, amount, first_name, last_name, bank_account_id }) => {
        if (!userId) return { error: "Not authenticated" };
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.createOfframpOrder({ pair_id, amount, customer_id: userId, first_name, last_name, bank_account_id });
          const o = result.data;
          const chain = (o.blockchain ?? "").startsWith("solana") ? "solana" : "evm";
          // Persist pending offramp order — webhook marks completed when INR lands in bank
          db.insert(payments).values({
            userId,
            type: "offramp",
            referenceId: o.order_id ? String(o.order_id) : null,
            description: `Offramp: ${o.input_amount ?? amount} ${o.input_currency ?? ""} → INR (${first_name} ${last_name})`,
            amountUsdc: String(o.input_amount ?? amount),
            status: "pending",
            chain,
          }).catch(() => {});
          return {
            order_id: o.order_id,
            deposit_address: o.deposit_address,
            blockchain: o.blockchain,
            send_exactly: `${o.input_amount} ${o.input_currency}`,
            estimated_inr: o.output_amount,
            expires_at: o.expires_at,
            instruction: `Send exactly ${o.input_amount} ${o.input_currency} to the deposit address on ${o.blockchain}. INR will be credited to your bank once confirmed.`,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to create order" };
        }
      },
    }),

    get_offramp_order: tool({
      description: "Check the current status of a specific offramp order by order ID.",
      inputSchema: z.object({
        order_id: z.string().describe("The offramp order ID to look up"),
      }),
      execute: async ({ order_id }) => {
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.getOfframpOrder(order_id);
          const o = result.data;
          return {
            order_id: o.order_id,
            status: o.status,
            send_amount: `${o.input_amount} ${o.input_currency}`,
            receive_amount_inr: o.output_amount,
            deposit_address: o.deposit_address,
            payout_utr: o.payout_utr,
            created_at: o.created_at,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch order" };
        }
      },
    }),

    list_offramp_orders: tool({
      description: "List the user's recent offramp (sell crypto for INR) orders with their statuses.",
      inputSchema: z.object({
        page: z.number().int().min(0).optional().describe("Page number for pagination (default 0)"),
        limit: z.number().optional().describe("Number of orders to return (default 10)"),
        status: z.string().optional().describe("Filter by status: CREATED, DEPOSIT_PENDING, DEPOSIT_CONFIRMED, PAYOUT_INITIATED, PAYOUT_COMPLETED, FAILED"),
      }),
      execute: async ({ page, limit, status }) => {
        if (!userId) return { error: "Not authenticated" };
        const provider = getBankingProvider();
        if (!provider) return { error: "Banking not configured" };
        try {
          const result = await provider.listOfframpOrders({ page: page ?? 0, limit: limit ?? 10, status, customer_id: userId });
          return {
            orders: (result.data ?? []).map((o: any) => ({
              order_id: o.order_id,
              status: o.status,
              sent: `${o.input_amount} ${o.input_currency}`,
              received_inr: o.output_amount,
              payout_utr: o.payout_utr,
              created_at: o.created_at,
            })),
            total: result.totalCount ?? 0,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to list orders" };
        }
      },
    }),

    // ── Velvet Capital — Portfolio Management ────────────────────────────────

    get_velvet_portfolios: tool({
      description:
        "List all Velvet Capital on-chain portfolios (vaults) owned by the user's wallet on Base. Returns portfolio names, IDs, and all contract addresses needed for further operations.",
      inputSchema: z.object({
        chain: z.enum(["base"]).optional().describe("Chain to query (default: base)"),
      }),
      execute: async ({ chain }) => {
        if (!walletAddress) return { error: "Wallet not connected" };
        try {
          const { getPortfoliosByOwner } = await import("@/lib/velvet");
          const portfolios = await getPortfoliosByOwner(walletAddress, chain ?? "base");
          return {
            portfolios: portfolios.map((p) => ({
              portfolio_id: p.portfolioId,
              name: p.name,
              symbol: p.symbol,
              portfolio_address: p.portfolio,
              vault_address: p.vaultAddress,
              rebalancing_address: p.rebalancing,
              asset_management_config: p.assetManagementConfig,
              token_exclusion_manager: p.tokenExclusionManager,
              is_public: p.public,
              chain: p.chainName,
              created_at: p.createdAt,
            })),
            count: portfolios.length,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch portfolios" };
        }
      },
    }),

    get_velvet_portfolio_info: tool({
      description:
        "Get full details of a Velvet portfolio: the user's token balance, ownership percentage, total supply, and each underlying token with its symbol and vault balance. Use this for a comprehensive portfolio view.",
      inputSchema: z.object({
        portfolio_id: z.string().describe("Portfolio ID from get_velvet_portfolios"),
      }),
      execute: async ({ portfolio_id }) => {
        if (!walletAddress) return { error: "Wallet not connected" };
        try {
          const { getPortfoliosByOwner, getPortfolioInfo } = await import("@/lib/velvet");
          const portfolios = await getPortfoliosByOwner(walletAddress);
          const portfolio = portfolios.find(
            (p) => p.portfolioId === portfolio_id || p.portfolio.toLowerCase() === portfolio_id.toLowerCase()
          );
          if (!portfolio) return { error: "Portfolio not found" };
          const info = await getPortfolioInfo(portfolio, walletAddress);
          return info;
        } catch (err: any) {
          return { error: err?.message ?? "Failed to fetch portfolio info" };
        }
      },
    }),

    get_velvet_portfolio_by_address: tool({
      description:
        "Look up a Velvet Capital portfolio directly by its on-chain contract address, without needing to be the owner. " +
        "Returns full portfolio info including tokens, balances, ownership %, rebalancing_address, asset_management_config, and token_exclusion_manager. " +
        "Use when the user provides a portfolio contract address directly rather than selecting from their list.",
      inputSchema: z.object({
        portfolio_address: z.string().describe("Velvet portfolio contract address (0x…) on Base"),
        user_address: z.string().describe("User's EVM wallet address (0x…) to calculate ownership share"),
      }),
      execute: async ({ portfolio_address, user_address }) => {
        try {
          const params = new URLSearchParams({ portfolio: portfolio_address, address: user_address });
          const r = await fetch(`${appBase()}/api/velvet/portfolio-by-address?${params}`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    manage_velvet_vault_list: tool({
      description:
        "Manage the user's Privy-stored Velvet vault watchlist — add, remove, hide, or unhide a vault from their dashboard. " +
        "Different from set_vault_pref (which uses the DB): this writes to Privy custom_metadata and manages the velvet_vaults / velvet_hidden lists. " +
        "Actions: add_vault (pin to dashboard), remove_vault (unpin), hide_vault (hide + unpin), unhide_vault (un-hide). " +
        "Use get_vault_prefs to read the current list before modifying.",
      inputSchema: z.object({
        action: z.enum(["add_vault", "remove_vault", "hide_vault", "unhide_vault"]).describe("Action to perform"),
        address: z.string().describe("Velvet portfolio contract address (0x…) on Base"),
      }),
      execute: async ({ action, address }) => {
        try {
          const r = await fetch(`${appBase()}/api/velvet/vaults`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, address }),
          });
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_velvet_vault_list: tool({
      description:
        "Get the user's Privy-stored Velvet vault watchlist — which portfolio addresses they've added (velvet_vaults) and which they've hidden (velvet_hidden). " +
        "Use this before manage_velvet_vault_list to see the current state, or when the user asks 'what vaults am I tracking?'.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/velvet/vaults`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    rebalance_velvet_portfolio: tool({
      description:
        "Prepare a rebalance transaction for a Velvet portfolio — swaps one token for another within the vault, changing the token composition. Returns encoded tx data the user must sign. Only call when the user explicitly confirms.",
      inputSchema: z.object({
        rebalancing_address: z.string().describe("Rebalancing contract address from get_velvet_portfolios"),
        sell_token: z.string().describe("Token address to sell out of the vault"),
        buy_token: z.string().describe("Token address to buy into the vault"),
        sell_amount: z.string().describe("Amount to sell in token's smallest unit (e.g. '1000000' for 1 USDC with 6 decimals)"),
        remaining_tokens: z.array(z.string()).describe("Addresses of tokens that will remain in the vault after this trade"),
        slippage_bps: z.string().optional().describe("Slippage tolerance in basis points — default '100' (1%)"),
      }),
      execute: async ({ rebalancing_address, sell_token, buy_token, sell_amount, remaining_tokens, slippage_bps }) => {
        if (!walletAddress) return { error: "Wallet not connected" };
        try {
          const { getRebalanceTxData } = await import("@/lib/velvet");
          const txData = await getRebalanceTxData({
            rebalanceAddress: rebalancing_address,
            sellToken: sell_token,
            buyToken: buy_token,
            sellAmount: sell_amount,
            slippage: slippage_bps ?? "100",
            remainingTokens: remaining_tokens,
            owner: walletAddress,
          });
          return {
            pendingRebalance: true,
            rebalancing_address,
            new_tokens: txData.newTokens,
            sell_tokens: txData.sellTokens,
            sell_amounts: txData.sellAmounts,
            handler: txData.handler,
            call_data: txData.callData,
            estimate_gas: txData.estimateGas,
            gas_price: txData.gasPrice,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to prepare rebalance" };
        }
      },
    }),

    update_velvet_weights: tool({
      description:
        "Prepare a weight-update transaction for a Velvet portfolio — adjusts token allocations without adding or removing tokens (sells some of one token to buy more of another already in the vault). Returns encoded tx data. Only call when user explicitly confirms.",
      inputSchema: z.object({
        rebalancing_address: z.string().describe("Rebalancing contract address from get_velvet_portfolios"),
        sell_token: z.string().describe("Token address to reduce (sell)"),
        buy_token: z.string().describe("Token address to increase (buy)"),
        sell_amount: z.string().describe("Amount to sell in token's smallest unit"),
        remaining_tokens: z.array(z.string()).describe("All current vault token addresses (no change to token list)"),
        slippage_bps: z.string().optional().describe("Slippage tolerance in basis points — default '100' (1%)"),
      }),
      execute: async ({ rebalancing_address, sell_token, buy_token, sell_amount, remaining_tokens, slippage_bps }) => {
        if (!walletAddress) return { error: "Wallet not connected" };
        try {
          const { getRebalanceTxData } = await import("@/lib/velvet");
          // updateWeights keeps all existing tokens — newTokens = all current tokens (no additions)
          const txData = await getRebalanceTxData({
            rebalanceAddress: rebalancing_address,
            sellToken: sell_token,
            buyToken: buy_token,
            sellAmount: sell_amount,
            slippage: slippage_bps ?? "100",
            remainingTokens: remaining_tokens,
            owner: walletAddress,
          });
          return {
            pendingWeightUpdate: true,
            rebalancing_address,
            sell_tokens: txData.sellTokens,
            sell_amounts: txData.sellAmounts,
            handler: txData.handler,
            call_data: txData.callData,
            estimate_gas: txData.estimateGas,
            gas_price: txData.gasPrice,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to prepare weight update" };
        }
      },
    }),

    deposit_velvet_portfolio: tool({
      description:
        "Prepare a deposit transaction to add ERC-20 tokens into a Velvet portfolio vault. Returns transaction data the user must sign. Only call when the user explicitly confirms.",
      inputSchema: z.object({
        portfolio_address: z.string().describe("Portfolio contract address from get_velvet_portfolios"),
        deposit_token: z.string().describe("ERC-20 token address to deposit"),
        deposit_amount: z.string().describe("Amount in token's smallest unit (e.g. '1000000' for 1 USDC with 6 decimals)"),
      }),
      execute: async ({ portfolio_address, deposit_token, deposit_amount }) => {
        if (!walletAddress) return { error: "Wallet not connected" };
        try {
          const { getDepositTxData } = await import("@/lib/velvet");
          const txData = await getDepositTxData({
            portfolio: portfolio_address,
            depositAmount: deposit_amount,
            depositToken: deposit_token,
            user: walletAddress,
          });
          return {
            pendingDeposit: true,
            portfolio_address,
            deposit_token,
            deposit_amount,
            tx: { to: txData.to, data: txData.data, gas_limit: txData.gasLimit, gas_price: txData.gasPrice },
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to prepare deposit" };
        }
      },
    }),

    withdraw_velvet_portfolio: tool({
      description:
        "Prepare a withdrawal transaction to burn portfolio tokens and receive an ERC-20 token from the Velvet vault. Returns transaction data the user must sign. Only call when the user explicitly confirms.",
      inputSchema: z.object({
        portfolio_address: z.string().describe("Portfolio contract address from get_velvet_portfolios"),
        withdraw_token: z.string().describe("ERC-20 token address to receive after withdrawal"),
        withdraw_amount: z.string().describe("Portfolio token amount to burn in smallest unit (18 decimals)"),
      }),
      execute: async ({ portfolio_address, withdraw_token, withdraw_amount }) => {
        if (!walletAddress) return { error: "Wallet not connected" };
        try {
          const { getWithdrawTxData } = await import("@/lib/velvet");
          const txData = await getWithdrawTxData({
            portfolio: portfolio_address,
            withdrawAmount: withdraw_amount,
            withdrawToken: withdraw_token,
            user: walletAddress,
          });
          return {
            pendingWithdrawal: true,
            portfolio_address,
            withdraw_token,
            withdraw_amount,
            tx: { to: txData.to, data: txData.data, gas_limit: txData.gasLimit, gas_price: txData.gasPrice },
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to prepare withdrawal" };
        }
      },
    }),

    remove_velvet_token: tool({
      description:
        "Prepare a transaction to remove a token from a Velvet portfolio vault (asset managers only). Can remove fully or partially by percentage. Only call when user explicitly confirms.",
      inputSchema: z.object({
        rebalancing_address: z.string().describe("Rebalancing contract address from get_velvet_portfolios"),
        token_address: z.string().describe("Address of the token to remove from the vault"),
        partial: z.boolean().describe("If true, removes only a percentage of the token; if false, removes entirely"),
        percentage: z.number().min(0).max(100).optional().describe("Percentage to remove (0–100) when partial=true"),
      }),
      execute: async ({ rebalancing_address, token_address, partial, percentage }) => {
        try {
          const { encodeRemovePortfolioToken } = await import("@/lib/velvet");
          const tx = partial && percentage !== undefined
            ? encodeRemovePortfolioToken(rebalancing_address, token_address, true, percentage)
            : encodeRemovePortfolioToken(rebalancing_address, token_address, false);
          return { pendingRemoveToken: true, token_address, partial, percentage, tx };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to prepare token removal" };
        }
      },
    }),

    propose_velvet_fee: tool({
      description:
        "Propose a new fee for a Velvet portfolio (asset managers only). After proposing, the fee takes effect 28 days later via update_velvet_fee. Returns encoded tx data to sign.",
      inputSchema: z.object({
        asset_management_config: z.string().describe("AssetManagementConfig contract address from get_velvet_portfolios"),
        fee_type: z.enum(["management", "performance", "entry_and_exit"]).describe("Which fee to change"),
        new_fee_bps: z.number().min(0).describe("New fee in basis points (e.g. 100 = 1%). For entry_and_exit this is the entry fee."),
        new_exit_fee_bps: z.number().min(0).optional().describe("New exit fee in basis points — only for fee_type 'entry_and_exit'"),
      }),
      execute: async ({ asset_management_config, fee_type, new_fee_bps, new_exit_fee_bps }) => {
        try {
          const { encodeFeeCall } = await import("@/lib/velvet");
          const tx = encodeFeeCall(asset_management_config, fee_type, "propose", new_fee_bps, new_exit_fee_bps);
          return {
            pendingFeeProposal: true,
            fee_type,
            new_fee_bps,
            new_exit_fee_bps,
            note: "Fee will be active after calling update_velvet_fee in 28 days",
            tx,
          };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to encode fee proposal" };
        }
      },
    }),

    update_velvet_fee: tool({
      description:
        "Finalize a previously proposed Velvet fee update (asset managers only). Can only succeed 28 days after the proposal. Can also cancel a pending proposal. Returns encoded tx data to sign.",
      inputSchema: z.object({
        asset_management_config: z.string().describe("AssetManagementConfig contract address from get_velvet_portfolios"),
        fee_type: z.enum(["management", "performance", "entry_and_exit"]).describe("Which fee to update or cancel"),
        action: z.enum(["update", "cancel"]).describe("'update' finalizes the fee after 28 days; 'cancel' deletes the pending proposal"),
      }),
      execute: async ({ asset_management_config, fee_type, action }) => {
        try {
          const { encodeFeeCall } = await import("@/lib/velvet");
          const tx = encodeFeeCall(asset_management_config, fee_type, action);
          return { pendingFeeAction: true, fee_type, action, tx };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to encode fee action" };
        }
      },
    }),

    manage_velvet_whitelist: tool({
      description:
        "Add or remove users from a Velvet portfolio's depositor whitelist (asset managers only). Only whitelisted users can deposit into private portfolios. Returns encoded tx data to sign.",
      inputSchema: z.object({
        asset_management_config: z.string().describe("AssetManagementConfig contract address from get_velvet_portfolios"),
        action: z.enum(["add", "remove"]).describe("'add' grants deposit access; 'remove' revokes it"),
        users: z.array(z.string()).describe("Wallet addresses to add or remove from the whitelist"),
      }),
      execute: async ({ asset_management_config, action, users }) => {
        try {
          const { encodeWhitelistCall } = await import("@/lib/velvet");
          const tx = encodeWhitelistCall(asset_management_config, action, users);
          return { pendingWhitelistUpdate: true, action, users, tx };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to encode whitelist update" };
        }
      },
    }),

    update_velvet_settings: tool({
      description:
        "Update Velvet portfolio settings (asset managers only): transferability, convert to public fund, update treasury address, set minimum holding amount, set initial portfolio amount, or enable Uniswap V3 management. Returns encoded tx data to sign.",
      inputSchema: z.object({
        asset_management_config: z.string().describe("AssetManagementConfig contract address from get_velvet_portfolios"),
        setting: z.enum(["transferability", "convert_to_public", "treasury", "min_holding_amount", "initial_amount", "enable_uniswap_v3"]).describe("Which setting to update"),
        transferable: z.boolean().optional().describe("For 'transferability': whether portfolio tokens can be transferred"),
        public_transfer: z.boolean().optional().describe("For 'transferability': whether transfers to non-whitelisted addresses are allowed"),
        new_treasury: z.string().optional().describe("For 'treasury': new address where management fees accumulate"),
        amount_wei: z.string().optional().describe("For 'min_holding_amount' or 'initial_amount': amount in wei (18 decimals)"),
      }),
      execute: async ({ asset_management_config, setting, transferable, public_transfer, new_treasury, amount_wei }) => {
        try {
          const lib = await import("@/lib/velvet");
          let tx: { to: string; data: string };
          if (setting === "transferability") {
            if (transferable === undefined) return { error: "transferable is required for transferability setting" };
            tx = lib.encodeTransferabilityCall(asset_management_config, transferable, public_transfer ?? false);
          } else if (setting === "convert_to_public") {
            tx = lib.encodeConvertToPublicCall(asset_management_config);
          } else if (setting === "treasury") {
            if (!new_treasury) return { error: "new_treasury address is required for treasury setting" };
            tx = lib.encodeTreasuryCall(asset_management_config, new_treasury);
          } else if (setting === "min_holding_amount") {
            if (!amount_wei) return { error: "amount_wei is required for min_holding_amount" };
            tx = lib.encodeMinHoldingAmountCall(asset_management_config, BigInt(amount_wei));
          } else if (setting === "initial_amount") {
            if (!amount_wei) return { error: "amount_wei is required for initial_amount" };
            tx = lib.encodeInitialPortfolioAmountCall(asset_management_config, BigInt(amount_wei));
          } else {
            tx = lib.encodeEnableUniswapV3ManagerCall(asset_management_config);
          }
          return { pendingSettingsUpdate: true, setting, tx };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to encode settings update" };
        }
      },
    }),

    manage_velvet_collateral: tool({
      description:
        "Enable or disable specific tokens as collateral in a Velvet portfolio vault (asset managers only). Collateral tokens can be used for borrowing against the vault's holdings. Returns encoded tx data to sign.",
      inputSchema: z.object({
        rebalancing_address: z.string().describe("Rebalancing contract address from get_velvet_portfolios"),
        action: z.enum(["enable", "disable"]).describe("Whether to enable or disable the tokens as collateral"),
        tokens: z.array(z.string()).describe("Token addresses to enable or disable as collateral"),
        controller: z.string().describe("Lending protocol controller address"),
      }),
      execute: async ({ rebalancing_address, action, tokens, controller }) => {
        try {
          const { encodeCollateralTokensCall } = await import("@/lib/velvet");
          const tx = encodeCollateralTokensCall(rebalancing_address, action, tokens, controller);
          return { pendingCollateralUpdate: true, action, tokens, tx };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to encode collateral update" };
        }
      },
    }),

    velvet_borrow: tool({
      description:
        "Borrow a token from a lending pool against collateral held in a Velvet portfolio vault (asset managers only). Enable collateral tokens first via manage_velvet_collateral. Returns encoded tx data to sign.",
      inputSchema: z.object({
        rebalancing_address: z.string().describe("Rebalancing contract address from get_velvet_portfolios"),
        pool: z.string().describe("Lending pool contract address"),
        tokens: z.array(z.string()).describe("Collateral token addresses pledged for the borrow"),
        token_to_borrow: z.string().describe("Address of the token to borrow"),
        controller: z.string().describe("Lending protocol controller address"),
        amount_wei: z.string().describe("Amount to borrow in the token's smallest unit"),
      }),
      execute: async ({ rebalancing_address, pool, tokens, token_to_borrow, controller, amount_wei }) => {
        try {
          const { encodeBorrowCall } = await import("@/lib/velvet");
          const tx = encodeBorrowCall(rebalancing_address, pool, tokens, token_to_borrow, controller, BigInt(amount_wei));
          return { pendingBorrow: true, token_to_borrow, amount_wei, tx };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to encode borrow" };
        }
      },
    }),

    // ── Flash Trade — Read-only queries ──────────────────────────────────────

    flash_get_tokens: tool({
      description: "List all tokens available on Flash Trade for swapping and liquidity operations (e.g. SOL, USDC, BTC, ETH, JitoSOL). Call this when the user asks what they can swap or deposit.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/tokens`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── Flash Trade — Quotes (read-only) ─────────────────────────────────────

    flash_get_open_quote: tool({
      description: "Get a price quote for opening a Flash Trade position — returns estimated entry price, fee, and size. Call this before flash_open_position so the user can see the cost.",
      inputSchema: z.object({
        market: z.string().describe("Market symbol, e.g. 'SOL', 'BTC'"),
        side: z.enum(["long", "short"]),
        collateralUsd: z.number().positive().describe("Collateral in USD"),
        leverage: z.number().min(1).max(100),
      }),
      execute: async ({ market, side, collateralUsd, leverage }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const { getMarketsInfo } = await import("@/lib/flash");
          const markets = getMarketsInfo();
          const m = markets.find(mk => mk.symbol.toUpperCase() === market.toUpperCase() && mk.side === side);
          if (!m) return { error: `Market ${market} ${side} not found` };
          const r = await fetch(`${appBase()}/api/flash/quote?marketId=${m.marketId}&collateral=${collateralUsd}&leverage=${leverage}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_get_close_quote: tool({
      description: "Get a price quote for closing a Flash Trade position — returns estimated exit price, fees, PnL, and how much the user will receive. Call before flash_close_position to show the user what they'll get.",
      inputSchema: z.object({
        marketId: z.number().int().describe("Market ID from flash_get_positions"),
        sizeDeltaUsd: z.number().positive().optional().describe("USD size to close — omit for full close quote"),
      }),
      execute: async ({ marketId, sizeDeltaUsd }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const params = new URLSearchParams({ wallet: solanaAddress, marketId: String(marketId) });
          if (sizeDeltaUsd != null) params.set("sizeDeltaUsd", String(sizeDeltaUsd));
          const r = await fetch(`${appBase()}/api/flash/close-quote?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_get_collateral_quote: tool({
      description: "Get a quote for adding or removing collateral on an open Flash Trade position — returns new leverage and new liquidation price. Call before flash_add_collateral or flash_remove_collateral.",
      inputSchema: z.object({
        marketId: z.number().int().describe("Market ID from flash_get_positions"),
        direction: z.enum(["add", "remove"]).describe("Whether the user is adding or removing collateral"),
        collateralUsd: z.number().positive().describe("Amount of collateral in USD"),
      }),
      execute: async ({ marketId, direction, collateralUsd }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const params = new URLSearchParams({ wallet: solanaAddress, marketId: String(marketId), direction, collateralUsd: String(collateralUsd) });
          const r = await fetch(`${appBase()}/api/flash/collateral-quote?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_get_swap_quote: tool({
      description: "Get a price quote for swapping tokens on Flash — returns estimated output amount and fee. Call before flash_swap to show the user what they'll receive.",
      inputSchema: z.object({
        inSymbol: z.string().describe("Token to sell, e.g. 'SOL'"),
        outSymbol: z.string().describe("Token to buy, e.g. 'USDC'"),
        amountIn: z.number().positive().describe("Amount of inSymbol to sell"),
      }),
      execute: async ({ inSymbol, outSymbol, amountIn }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/swap-quote?inSymbol=${inSymbol}&outSymbol=${outSymbol}&amountIn=${amountIn}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_get_liquidity_quote: tool({
      description: "Get a quote for Flash liquidity operations — how much FLP/sFLP you'll receive when adding, or how much token you'll get when removing. Call before flash_add_liquidity, flash_remove_liquidity, flash_add_compounding, or flash_remove_compounding.",
      inputSchema: z.object({
        action: z.enum(["add", "remove", "sflp-add", "sflp-remove"]).describe("'add'=add FLP, 'remove'=remove FLP, 'sflp-add'=add sFLP, 'sflp-remove'=remove sFLP"),
        symbol: z.string().describe("Token symbol — for add: the token you deposit (e.g. 'USDC'); for remove: the token you want back (e.g. 'USDC')"),
        amount: z.number().positive().describe("For add: amount of token to deposit; for remove: amount of FLP/sFLP tokens to burn"),
      }),
      execute: async ({ action, symbol, amount }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/liquidity-quote?action=${action}&symbol=${symbol}&amount=${amount}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── Flash Trade — Perpetuals ──────────────────────────────────────────────

    flash_get_markets: tool({
      description: "List all Flash Trade perpetual markets with current prices, funding rates and available leverage. Call this before opening a position or when the user asks about tradeable assets.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/markets`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_get_positions: tool({
      description: "Get the user's open Flash Trade positions and pending orders on Solana. Returns marketId, side, size, collateral, entry price, and current PnL for each position.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/positions?ownerAddress=${solanaAddress}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_get_position_stats: tool({
      description: "Get real-time PnL and liquidation price for a specific open Flash Trade position. Call after flash_get_positions to get the marketId.",
      inputSchema: z.object({
        marketId: z.number().int().describe("Market ID from flash_get_positions"),
      }),
      execute: async ({ marketId }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(
            `${appBase()}/api/flash/position-stats?wallet=${solanaAddress}&marketId=${marketId}`
          );
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_deposit_to_vault: tool({
      description: "Deposit tokens into the Flash Trade vault to use as collateral for trading. The vault holds funds ready for positions.",
      inputSchema: z.object({
        tokenSymbol: z.string().describe("Token to deposit, e.g. 'USDC', 'SOL'"),
        amount: z.number().positive().describe("Amount to deposit"),
      }),
      execute: async ({ tokenSymbol, amount }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/deposit-direct`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, tokenSymbol, amount }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "deposit_to_vault", args: { tokenSymbol, amount }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_withdraw_from_vault: tool({
      description: "Withdraw tokens from the Flash Trade vault back to the user's wallet.",
      inputSchema: z.object({
        tokenSymbol: z.string().describe("Token to withdraw, e.g. 'USDC'"),
        amount: z.number().positive().describe("Amount to withdraw"),
      }),
      execute: async ({ tokenSymbol, amount }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/withdrawal`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, tokenSymbol, amount }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "withdraw_from_vault", args: { tokenSymbol, amount }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_open_position: tool({
      description: "Prepare a leveraged long or short position on Flash Trade. Returns a pending Solana transaction for the user to sign — NEVER call without explicit confirmation of market, side, collateral and leverage. To add TP/SL, call flash_place_trigger_order after the position is confirmed open.",
      inputSchema: z.object({
        market: z.string().describe("Market symbol, e.g. 'SOL', 'BTC', 'ETH'"),
        side: z.enum(["long", "short"]).describe("Direction of the trade"),
        collateralSymbol: z.string().default("USDC").describe("Token used as collateral, usually 'USDC'"),
        collateralUsd: z.number().positive().describe("Collateral amount in USD"),
        leverage: z.number().min(1).max(100).describe("Leverage multiplier (1–100)"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-open`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "open_position", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_close_position: tool({
      description: "Close or partially close an open Flash Trade position. Use flash_get_positions first to get the marketId.",
      inputSchema: z.object({
        marketId: z.number().int().describe("Market ID from flash_get_positions"),
        closePercent: z.number().min(1).max(100).default(100).describe("Percentage to close (100 = full close)"),
        collateralSymbol: z.string().default("USDC").describe("Collateral token symbol"),
      }),
      execute: async ({ marketId, closePercent, collateralSymbol }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const endpoint = closePercent < 100 ? "/api/flash/build-partial-close" : "/api/flash/build-close";
          const r = await fetch(`${appBase()}${endpoint}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, marketId, closePercent, collateralSymbol }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "close_position", args: { marketId, closePercent }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_place_limit_order: tool({
      description: "Place a limit entry order on Flash Trade at a specific price.",
      inputSchema: z.object({
        market: z.string().describe("Market symbol, e.g. 'SOL'"),
        side: z.enum(["long", "short"]),
        collateralSymbol: z.string().default("USDC"),
        collateralUsd: z.number().positive(),
        leverage: z.number().min(1).max(100),
        limitPrice: z.number().positive().describe("Entry price trigger in USD"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-limit-order`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "limit_order", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_place_trigger_order: tool({
      description: "Set a stop-loss or take-profit trigger on an open Flash Trade position.",
      inputSchema: z.object({
        marketId: z.number().int(),
        isStopLoss: z.boolean().describe("true = stop-loss, false = take-profit"),
        triggerPrice: z.number().positive().describe("Trigger price in USD"),
        deltaSizeUsd: z.number().positive().describe("Position size reduction in USD when triggered"),
        collateralSymbol: z.string().default("USDC"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-trigger-order`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "trigger_order", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_cancel_order: tool({
      description: "Cancel a pending Flash Trade limit or trigger order. For trigger orders, isStopLoss must match the order being cancelled — get it from flash_get_positions.",
      inputSchema: z.object({
        marketId: z.number().int(),
        orderId: z.number().int(),
        orderType: z.enum(["limit", "trigger"]),
        isStopLoss: z.boolean().optional().describe("Required when orderType='trigger': true for stop-loss, false for take-profit"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/cancel-order`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "cancel_order", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_add_collateral: tool({
      description: "Add collateral to an open Flash Trade position to reduce liquidation risk.",
      inputSchema: z.object({
        marketId: z.number().int(),
        collateralSymbol: z.string().default("USDC"),
        amountUsd: z.number().positive().describe("Amount of collateral to add in USD"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-add-collateral`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "add_collateral", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_remove_collateral: tool({
      description: "Remove collateral from an open Flash Trade position.",
      inputSchema: z.object({
        marketId: z.number().int(),
        collateralSymbol: z.string().default("USDC"),
        amountUsd: z.number().positive().describe("Amount of collateral to remove in USD"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-remove-collateral`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "remove_collateral", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── Flash Swap & Earn ─────────────────────────────────────────────────────

    flash_swap: tool({
      description: "Swap one token for another using Flash Trade's AMM on Solana. Call this when the user says 'swap X SOL for USDC' or similar.",
      inputSchema: z.object({
        inSymbol: z.string().describe("Token to sell, e.g. 'SOL'"),
        outSymbol: z.string().describe("Token to buy, e.g. 'USDC'"),
        amountIn: z.number().positive().describe("Amount of inSymbol to sell"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-swap`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "swap", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_add_liquidity: tool({
      description: "Add liquidity to Flash's FLP pool to earn trading fees. The user deposits a token and receives FLP tokens.",
      inputSchema: z.object({
        inSymbol: z.string().describe("Token to deposit, e.g. 'USDC', 'SOL'"),
        amountIn: z.number().positive(),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-add-liquidity`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "add_liquidity", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_remove_liquidity: tool({
      description: "Remove FLP liquidity from Flash pool. The user burns FLP tokens and receives a chosen token back.",
      inputSchema: z.object({
        outSymbol: z.string().describe("Token to receive back, e.g. 'USDC'"),
        lpAmountIn: z.number().positive().describe("Amount of FLP tokens to burn"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-remove-liquidity`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "remove_liquidity", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_add_compounding: tool({
      description: "Add sFLP (auto-compounding) liquidity to Flash pool. Rewards are automatically reinvested.",
      inputSchema: z.object({
        inSymbol: z.string().describe("Token to deposit"),
        amountIn: z.number().positive(),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-add-compounding`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "add_compounding", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_remove_compounding: tool({
      description: "Remove sFLP (auto-compounding) liquidity from Flash pool.",
      inputSchema: z.object({
        outSymbol: z.string().describe("Token to receive back"),
        sflpAmountIn: z.number().positive().describe("Amount of sFLP tokens to burn"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-remove-compounding`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "remove_compounding", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_stake_flash: tool({
      description: "Stake FLASH tokens to earn protocol rewards.",
      inputSchema: z.object({ amount: z.number().positive().describe("Amount of FLASH tokens to stake") }),
      execute: async ({ amount }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-stake`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, amount }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "stake_flash", args: { amount }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_unstake_flash: tool({
      description: "Request to unstake FLASH tokens (starts a cooldown period on-chain).",
      inputSchema: z.object({ amount: z.number().positive().describe("Amount of FLASH tokens to unstake") }),
      execute: async ({ amount }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-unstake`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, amount }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "unstake_flash", args: { amount }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_cancel_unstake: tool({
      description: "Cancel a pending FLASH unstake request by its request ID.",
      inputSchema: z.object({ withdrawRequestId: z.number().int().min(0) }),
      execute: async ({ withdrawRequestId }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/cancel-unstake`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, withdrawRequestId }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "cancel_unstake", args: { withdrawRequestId }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_withdraw_flash: tool({
      description: "Withdraw FLASH tokens after the unstake cooldown has completed. Requires the withdraw request ID.",
      inputSchema: z.object({ withdrawRequestId: z.number().int().min(0) }),
      execute: async ({ withdrawRequestId }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/withdraw-flash`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, withdrawRequestId }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "withdraw_flash", args: { withdrawRequestId }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_collect_stake_reward: tool({
      description: "Collect accumulated FLASH token staking rewards.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/collect-stake-reward`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "collect_stake_reward", args: {}, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_collect_flp_reward: tool({
      description: "Collect FLP liquidity staking rewards (paid in USDC).",
      inputSchema: z.object({}),
      execute: async () => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/collect-flp-reward`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "collect_flp_reward", args: {}, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_collect_rebate: tool({
      description: "Collect accumulated Flash Trade trading fee rebates (paid in USDC).",
      inputSchema: z.object({}),
      execute: async () => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/collect-rebate`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "collect_rebate", args: {}, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_cancel_all_triggers: tool({
      description: "Cancel ALL stop-loss and take-profit trigger orders for a specific market at once.",
      inputSchema: z.object({
        marketId: z.number().int().describe("Market ID from flash_get_positions"),
      }),
      execute: async ({ marketId }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/cancel-all-triggers`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, marketId }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "cancel_all_triggers", args: { marketId }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_migrate_to_sflp: tool({
      description: "Convert staked FLP tokens into sFLP (auto-compounding). Rewards then compound automatically instead of needing manual claims.",
      inputSchema: z.object({
        flpAmount: z.number().positive().describe("Amount of FLP tokens to convert to sFLP"),
      }),
      execute: async ({ flpAmount }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/migrate-stake`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, flpAmount }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "migrate_to_sflp", args: { flpAmount }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_migrate_to_flp: tool({
      description: "Convert sFLP (auto-compounding) back into staked FLP. Rewards must then be claimed manually.",
      inputSchema: z.object({
        sflpAmount: z.number().positive().describe("Amount of sFLP tokens to convert back to staked FLP"),
      }),
      execute: async ({ sflpAmount }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/migrate-flp`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, sflpAmount }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "migrate_to_flp", args: { sflpAmount }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_collect_revenue: tool({
      description: "Collect referral program revenue share from Flash Trade (for users who have referred active traders).",
      inputSchema: z.object({
        revenueTokenSymbol: z.string().default("USDC").describe("Token to receive revenue in, usually USDC"),
      }),
      execute: async ({ revenueTokenSymbol }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/collect-revenue`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, revenueTokenSymbol }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "collect_revenue", args: { revenueTokenSymbol }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_increase_position: tool({
      description: "Increase the size of an existing open Flash Trade position by adding more collateral and increasing leverage. Use when the user says 'add to my position', 'increase my long', or 'scale into my trade'. Call flash_get_positions first to get the marketId.",
      inputSchema: z.object({
        marketId: z.number().int().describe("Market ID from flash_get_positions"),
        addCollateralUsd: z.number().positive().describe("Additional collateral to add in USD"),
        sizeDeltaUsd: z.number().positive().describe("Position size increase in USD notional"),
        slippageBps: z.number().int().min(1).max(500).default(100).describe("Slippage tolerance in basis points (100 = 1%)"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/build-increase-position`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "increase_position", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_edit_limit_order: tool({
      description: "Edit an existing Flash Trade limit order — change the entry price, size, take-profit, or stop-loss. Use flash_get_positions first to get the marketId and orderId.",
      inputSchema: z.object({
        marketId: z.number().int(),
        orderId: z.number().int(),
        newLimitPrice: z.number().positive().describe("New entry limit price in USD"),
        newSizeUsd: z.number().positive().describe("New position size in USD notional"),
        newTakeProfitPrice: z.number().positive().optional().describe("New take-profit price in USD"),
        newStopLossPrice: z.number().positive().optional().describe("New stop-loss price in USD"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/edit-order`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, orderType: "limit", ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "edit_limit_order", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_edit_trigger_order: tool({
      description: "Edit an existing Flash Trade stop-loss or take-profit trigger order — change the trigger price or size. Use flash_get_positions first to get the marketId and orderId.",
      inputSchema: z.object({
        marketId: z.number().int(),
        orderId: z.number().int(),
        isStopLoss: z.boolean().describe("true = stop-loss, false = take-profit"),
        newTriggerPrice: z.number().positive().describe("New trigger price in USD"),
        newDeltaSizeUsd: z.number().positive().describe("New size reduction in USD when triggered"),
      }),
      execute: async (args) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/edit-order`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, orderType: "trigger", ...args }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "edit_trigger_order", args, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    flash_create_session: tool({
      description: "Create a Flash Trade trading session so the user can trade without signing every transaction. The session lasts up to 24 hours. After approval, Bluvfi can execute trades automatically on their behalf. Always confirm before creating.",
      inputSchema: z.object({
        durationHours: z.number().min(0.5).max(24).default(8).describe("Session duration in hours (max 24)"),
      }),
      // The session keypair must be generated client-side (FlashSessionApprovalCard) so the private key
      // never touches the server. We just return the pending marker here; the card handles the API call.
      execute: async ({ durationHours }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        return { pendingFlashSession: true, action: "create_session", args: { durationHours }, solanaAddress };
      },
    }),

    flash_revoke_session: tool({
      description: "Revoke the active Flash Trade trading session, stopping automatic trade execution immediately.",
      inputSchema: z.object({}),
      // The session keypair pubkey lives in the browser's localStorage — the server cannot access it.
      // Return a pendingFlashRevoke marker; FlashRevokeSessionCard reads localStorage and handles the full flow client-side.
      execute: async () => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        return { pendingFlashRevoke: true, solanaAddress };
      },
    }),

    flash_create_referral: tool({
      description: "Link a referrer wallet address for the user on Flash Trade to start earning rebates.",
      inputSchema: z.object({ referrerAddress: z.string().describe("The referrer's Solana wallet address") }),
      execute: async ({ referrerAddress }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const r = await fetch(`${appBase()}/api/flash/create-referral`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerAddress: solanaAddress, referrerAddress }),
          });
          if (!r.ok) return { error: await r.text() };
          const { transaction } = await r.json();
          return { pendingFlashTx: true, action: "create_referral", args: { referrerAddress }, transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_find_user: tool({
      description: `Look up or register the user's Oro GRAIL gold-trading account by their Solana wallet address.
Returns { grail_user_id, created, wallet_address } — pass grail_user_id directly to grail_gold_price, grail_list_trades, grail_list_redemptions, etc.
ALWAYS call this first before grail_gold_price, grail_list_trades, or grail_list_redemptions.
grail_get_denominations, grail_get_trade, and grail_get_redemption do NOT need this — call them directly.
Pass country (ISO 3166-1 alpha-2) if you know it — e.g. PK for Pakistan, AE for UAE, SA for Saudi Arabia. Defaults to US if omitted.
created=true means the account was just created; created=false means it already existed.`,
      inputSchema: z.object({
        country: z.string().length(2).optional().describe("User's country code e.g. PK, AE, SA, NG, US, GB, GH, KE, ZA, SG — ask if unknown and this might be a new user"),
      }),
      execute: async ({ country }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected — user must connect a Solana wallet first" };
        try {
          const r = await fetch(`${appBase()}/api/grail/users`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              wallet_address: solanaAddress,
              full_name: userName ?? "Bluvfi User",
              ...(country ? { country: country.toUpperCase() } : {}),
            }),
          });
          if (!r.ok) return { error: await r.text() };
          const data = await r.json();
          return { grail_user_id: data.grailUserId, created: data.created, wallet_address: solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_gold_price: tool({
      description: `Get the current live gold spot price in USD per troy ounce from Oro GRAIL.
Prerequisite: call grail_find_user first to get grail_user_id, then pass it here.
Present the result as e.g. "Gold is $3,245/troy oz (0.3% fee)".`,
      inputSchema: z.object({
        grail_user_id: z.string().describe("GRAIL user ID from grail_find_user"),
      }),
      execute: async ({ grail_user_id }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/buy`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grail_user_id, usdc_amount: 10 }),
          });
          const data = await r.json();
          if (data?.quote?.price_per_troy_oz) {
            return {
              price_per_troy_oz: data.quote.price_per_troy_oz,
              currency: "USD",
              fee_bps: data.quote.fee_bps,
              source: "Oro GRAIL",
            };
          }
          return { error: data.error ?? "Price unavailable" };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_quote_sell: tool({
      description: `Get a sell quote for Oro GRAIL gold — shows how many USDC the user would receive for a given amount of $GOLD tokens.
Prerequisite: call grail_find_user first to get grail_user_id.
Use this when the user wants to know what their gold is worth before deciding to sell.
Returns: { quote: { usdc_amount, gold_amount, price_per_troy_oz, fee_bps, fee_usd }, trade_id } — the trade_id is for the pending quote (expires shortly). The actual sell execution must be done in the UI (requires wallet signature).
Present as e.g. "Selling 0.01 $GOLD would give you $X USDC (fee: $Y)".`,
      inputSchema: z.object({
        grail_user_id: z.string().describe("GRAIL user ID from grail_find_user"),
        gold_amount: z.number().positive().describe("Amount of $GOLD tokens to quote selling"),
        slippage_bps: z.number().int().min(1).max(500).default(50).describe("Slippage tolerance in basis points (default 50 = 0.5%)"),
      }),
      execute: async ({ grail_user_id, gold_amount, slippage_bps }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/sell`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grail_user_id, gold_amount, slippage_bps }),
          });
          if (!r.ok) return { error: await r.text() };
          const data = await r.json();
          return {
            quote: data.quote,
            trade_id: data.trade_id,
            note: "Quote obtained. To execute the sell, use the Grail section in the app (requires wallet signature).",
          };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_list_trades: tool({
      description: `List the user's Oro GRAIL gold buy/sell trade history.
Prerequisite: call grail_find_user first to get grail_user_id.
Returns { trades: [...] } — each trade has: trade_id, side (buy/sell), status (confirmed/pending/failed), usdc_amount, gold_amount, price_per_troy_oz, fee_bps, fee_usd, submitted_tx_hash, created_at, updated_at.
Summarise clearly — e.g. "You bought 0.003 $GOLD for $10 on Jan 5 (confirmed)".`,
      inputSchema: z.object({
        grail_user_id: z.string().describe("GRAIL user ID from grail_find_user"),
        limit: z.number().int().min(1).max(50).default(10).describe("Number of trades to return"),
        side: z.enum(["buy", "sell"]).optional().describe("Filter to only buys or only sells"),
        status: z.string().optional().describe("Filter by status: confirmed, pending, or failed"),
      }),
      execute: async ({ grail_user_id, limit, side, status }) => {
        try {
          const sp = new URLSearchParams({ grail_user_id, limit: String(limit) });
          if (side) sp.set("side", side);
          if (status) sp.set("status", status);
          const r = await fetch(`${appBase()}/api/grail/trades?${sp}`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_get_trade: tool({
      description: `Get the current status and full details of a specific Oro GRAIL gold trade.
Use to check if a pending trade confirmed, or to look up a trade by ID the user mentions.
Returns: trade_id, side (buy/sell), status (confirmed/pending/failed), usdc_amount, gold_amount, price_per_troy_oz, fee_bps, fee_usd, submitted_tx_hash, created_at, updated_at.`,
      inputSchema: z.object({
        trade_id: z.string().describe("Trade ID — shown in trade history or returned after a buy/sell"),
      }),
      execute: async ({ trade_id }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/trades/${trade_id}`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_list_redemptions: tool({
      description: `List the user's physical gold redemption requests on Oro GRAIL.
Prerequisite: call grail_find_user first to get grail_user_id.
Returns { redemptions: [...] } — each item: redemption_id, status (pending/confirmed/cancelled), denomination, weight_g, city, cancellation_reason, submitted_tx_hash, created_at, updated_at, quote { tokens_required, spot_price_usd, gold_value_usd, fee_usd, total_usd }.
To cancel a pending redemption, use grail_cancel_redemption with the redemption_id.`,
      inputSchema: z.object({
        grail_user_id: z.string().describe("GRAIL user ID from grail_find_user"),
        status: z.string().optional().describe("Filter by status: pending, confirmed, or cancelled"),
        city: z.string().optional().describe("Filter by delivery city"),
      }),
      execute: async ({ grail_user_id, status, city }) => {
        try {
          const sp = new URLSearchParams({ grail_user_id });
          if (status) sp.set("status", status);
          if (city) sp.set("city", city);
          const r = await fetch(`${appBase()}/api/grail/redemptions?${sp}`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_get_denominations: tool({
      description: `List the physical gold bar and coin denominations available for redemption in a specific country via Oro GRAIL.
Use when the user asks what gold they can redeem, what sizes are available, or before directing them to the Redeem tab.
Returns: id, label, weight_g, weight_troy_oz, city (delivery location).
To actually redeem, direct the user to Invest → Oro Gold → Redeem tab.`,
      inputSchema: z.object({
        country: z.string().length(2).describe("ISO 3166-1 alpha-2 country code — confirmed active: PK (Pakistan), AE (UAE), SA (Saudi Arabia); also: NG, US, GB, GH, KE, ZA, SG"),
      }),
      execute: async ({ country }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/denominations?country=${country.toUpperCase()}`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_get_redemption: tool({
      description: `Get the current status and full details of a specific Oro GRAIL physical gold redemption request.
Use to check if a pending redemption has been confirmed, or to look up a redemption by ID the user mentions.
No grail_find_user call needed — just pass the redemption_id directly.
Returns: redemption_id, status (pending/confirmed/cancelled), denomination, weight_g, city, cancellation_reason, submitted_tx_hash, created_at, updated_at, quote { tokens_required, spot_price_usd, gold_value_usd, fee_usd, total_usd }.`,
      inputSchema: z.object({
        redemption_id: z.string().describe("Redemption ID — shown in redemption history or mentioned by the user"),
      }),
      execute: async ({ redemption_id }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/redemptions/${redemption_id}`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_cancel_redemption: tool({
      description: `Cancel a pending Oro GRAIL physical gold redemption request.
Only pending redemptions can be cancelled — confirmed or already-cancelled ones cannot.
Use grail_list_redemptions first to get the redemption_id, then confirm with the user before cancelling.
Returns: { redemption_id, status: "cancelled" }`,
      inputSchema: z.object({
        redemption_id: z.string().describe("Redemption ID from grail_list_redemptions"),
        reason: z.string().min(3).describe("Short reason for cancellation, e.g. 'Changed my mind' or 'Wrong city entered'"),
      }),
      execute: async ({ redemption_id, reason }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/redemptions/${redemption_id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
          });
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_list_users: tool({
      description: `List all GRAIL users registered under this partner account.
Returns { users: [...] } — each user has: grail_user_id, created_at, wallet_address, kyc_status.
Use for admin/support lookups when you need to browse all registered gold investors.
Prefer grail_find_user for looking up a specific user by wallet address.`,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/grail/users`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_create_redemption: tool({
      description: `Create a new physical gold redemption request — generates a quote for redeeming $GOLD tokens for physical gold delivery.
Steps: (1) call grail_get_denominations to list available coin denominations and cities, (2) call this with denomination_id and city, (3) the response contains redemption_id + unsigned transaction — the user must sign it, (4) call grail_submit_redemption with the signed tx.
Returns: { redemption_id, status: "pending", denomination, weight_g, city, quote: { tokens_required, spot_price_usd, gold_value_usd, fee_usd, total_usd }, unsigned_tx }.
Always show the quote to the user and confirm before proceeding to signing.`,
      inputSchema: z.object({
        grail_user_id: z.string().describe("GRAIL user ID from grail_find_user"),
        denomination_id: z.string().describe("Denomination ID from grail_get_denominations, e.g. '1oz_coin'"),
        city: z.string().describe("Delivery city from grail_get_denominations, e.g. 'Dubai', 'Singapore'"),
      }),
      execute: async ({ grail_user_id, denomination_id, city }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/redemptions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grail_user_id, denomination_id, city }),
          });
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_get_user: tool({
      description: `Fetch a specific GRAIL user's profile by their GRAIL user ID.
Returns full KYC status, account tier, balance, and linked wallet address.
Use after grail_find_user (which searches by email/name) when you already have the user_id and need the latest profile details.`,
      inputSchema: z.object({
        grail_user_id: z.string().describe("GRAIL user ID (from grail_find_user or a prior grail_get_user call)"),
      }),
      execute: async ({ grail_user_id }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/users/${encodeURIComponent(grail_user_id)}`);
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_submit_buy: tool({
      description: `Submit a fully signed GRAIL buy transaction to execute the gold purchase on-chain.
Call ONLY after the user has signed the transaction returned by grail_gold_price (which initiates a buy quote).
The signed_tx is the base64-encoded signed transaction from the user's Solana wallet.
Returns: { trade_id, status, message } — success means the purchase is executing.`,
      inputSchema: z.object({
        trade_id: z.string().describe("Trade ID from the grail_gold_price buy quote"),
        signed_tx: z.string().describe("Base64-encoded signed Solana transaction from the user's wallet"),
      }),
      execute: async ({ trade_id, signed_tx }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/buy/${encodeURIComponent(trade_id)}/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signed_tx }),
          });
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_submit_sell: tool({
      description: `Submit a fully signed GRAIL sell transaction to execute the gold sale on-chain.
Call ONLY after the user has signed the transaction returned by grail_quote_sell (which initiates a sell quote).
The signed_tx is the base64-encoded signed transaction from the user's Solana wallet.
Returns: { trade_id, status, message } — success means the sell order is executing.`,
      inputSchema: z.object({
        trade_id: z.string().describe("Trade ID from the grail_quote_sell sell quote"),
        signed_tx: z.string().describe("Base64-encoded signed Solana transaction from the user's wallet"),
      }),
      execute: async ({ trade_id, signed_tx }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/sell/${encodeURIComponent(trade_id)}/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signed_tx }),
          });
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    grail_submit_redemption: tool({
      description: `Submit a fully signed GRAIL redemption transaction to initiate physical gold delivery.
Call ONLY after the user has confirmed their delivery address and signed the transaction.
The signed_tx is the base64-encoded signed Solana transaction authorising the gold withdrawal.
Returns: { redemption_id, status, estimated_delivery } — success means physical delivery is being arranged.`,
      inputSchema: z.object({
        redemption_id: z.string().describe("Redemption ID from grail_list_redemptions"),
        signed_tx: z.string().describe("Base64-encoded signed Solana transaction from the user's wallet"),
      }),
      execute: async ({ redemption_id, signed_tx }) => {
        try {
          const r = await fetch(`${appBase()}/api/grail/redemptions/${encodeURIComponent(redemption_id)}/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signed_tx }),
          });
          if (!r.ok) return { error: await r.text() };
          return r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── Roaster ──────────────────────────────────────────────────────────────

    roaster_list_battles: tool({
      description: `List Roaster AI rap battles. Roaster is a platform on Solana where AI writes the bars, an AI Jury (Claude + GPT + Gemini) picks the winner, and users back a side with USDC.
Returns: { battles: [...], total } — each battle has: battle_id, topic, sides[0/1] (name, pool_usdc, track_url, rap_id, creator_address), status (open/live/judging/settled/voided), duration_tier (15m/6h/24h), starts_at, ends_at, total_pool_usdc, winner_side (0 or 1 if settled), jury_transcript_url, jury_irys_tx_id.
Use to browse active battles, check pools, find a specific battle, or load the user's created battles.`,
      inputSchema: z.object({
        status: z.enum(["open", "live", "judging", "settled", "voided"]).optional()
          .describe("Filter by status — omit for all battles"),
        limit: z.number().int().min(1).max(50).default(20).describe("Number of battles to return"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset for loading more"),
        creator_address: z.string().optional().describe("Filter to battles created by this Solana address"),
      }),
      execute: async ({ status, limit, offset, creator_address }) => {
        try {
          const { listBattles } = await import("@/lib/roaster");
          return await listBattles({ status, limit, offset, creator_address });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_get_battle: tool({
      description: `Get full details of a specific Roaster rap battle by ID.
Returns: battle_id, topic, sides[0/1] (name, pool_usdc, track_url, rap_id, creator_address), status (open/live/judging/settled/voided), duration_tier, starts_at, ends_at, total_pool_usdc, winner_side (0|1 if settled), jury_transcript_url, jury_irys_tx_id, creator_address (battle creator), creation_bond_usdc.
Use when the user mentions a specific battle_id, wants status on a battle, or you need pool sizes before estimating payout.`,
      inputSchema: z.object({
        battle_id: z.string().describe("Battle ID from roaster_list_battles or mentioned by the user"),
      }),
      execute: async ({ battle_id }) => {
        try {
          const { getBattle } = await import("@/lib/roaster");
          return await getBattle(battle_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_get_leaderboard: tool({
      description: `Get the Roaster leaderboard — top earners, most wins, or top battle creators.
Returns: { entries: [...], total } — each entry: rank, address, username, wins, losses, total_backed_usdc, total_earned_usdc, battles_created, raps_created.
Present as a ranked list. Top 3 get a trophy emoji. Abbreviate addresses to first4…last4.`,
      inputSchema: z.object({
        metric: z.enum(["earnings", "wins", "battles_created"]).default("earnings")
          .describe("Sort metric: earnings (total USDC earned), wins (win count), battles_created"),
        limit: z.number().int().min(1).max(50).default(10).describe("Number of entries to return"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }),
      execute: async ({ metric, limit, offset }) => {
        try {
          const { getLeaderboard } = await import("@/lib/roaster");
          return await getLeaderboard({ metric, limit, offset });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_get_wallet: tool({
      description: `Get the user's Roaster Battle Wallet balance and pending payouts on Solana.
Returns: { address, balance_usdc, pending_payouts_usdc }.
The Battle Wallet is an embedded Solana wallet auto-created at signup — USDC goes in/out to battle vaults on-chain.`,
      inputSchema: z.object({}),
      execute: async () => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const { getBattleWallet } = await import("@/lib/roaster");
          return await getBattleWallet(solanaAddress);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_get_my_backings: tool({
      description: `List the user's battle backings on Roaster — which sides they've backed and for how much.
Returns: { backings: [...] } — each: backing_id, battle_id, side (0=A or 1=B), amount_usdc, time_weight (higher = earlier backer = more potential payout), potential_payout_usdc, created_at.
Use to show portfolio of bets, check a specific battle backing, or summarise total USDC at risk.`,
      inputSchema: z.object({
        battle_id: z.string().optional().describe("Filter to a specific battle"),
        limit: z.number().int().min(1).max(50).default(20).describe("Number of backings to return"),
      }),
      execute: async ({ battle_id, limit }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const { getMyBackings } = await import("@/lib/roaster");
          return await getMyBackings({ backer_address: solanaAddress, battle_id, limit });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_get_backings: tool({
      description: `List all backings for a specific battle on Roaster — who backed which side, for how much, and what their time-weighted potential payout is.
Unlike roaster_get_my_backings (which filters to the current user), this returns ALL backings for a battle.
Returns: { backings: [...] } — each: backing_id, battle_id, side (0=A or 1=B), backer_address, amount_usdc, time_weight, potential_payout_usdc, created_at.
Use when user asks "who backed this battle?", "show me all bets on battle X", or to display a battle's backer leaderboard.`,
      inputSchema: z.object({
        backer_address: z.string().describe("Filter to backings by this Solana wallet address"),
        battle_id: z.string().optional().describe("Filter to a specific battle ID"),
        limit: z.number().int().min(1).max(50).optional().describe("Max backings to return"),
      }),
      execute: async ({ backer_address, battle_id, limit }) => {
        try {
          const { getMyBackings } = await import("@/lib/roaster");
          return await getMyBackings({ backer_address, battle_id, limit });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_get_rap: tool({
      description: `Get the status and details of a specific Roaster rap by ID.
Use to check if AI generation finished (status: generating → ready), get the track URL, or view the bars.
Returns: rap_id, battle_id, side (0=A/1=B), creator_address, angles, bars, track_url, status (generating/ready/failed), created_at.`,
      inputSchema: z.object({
        rap_id: z.string().describe("Rap ID — returned when a rap is created, or from battle sides"),
      }),
      execute: async ({ rap_id }) => {
        try {
          const { getRap } = await import("@/lib/roaster");
          return await getRap(rap_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_create_rap: tool({
      description: `Submit creative angles for a Roaster battle side — AI writes every bar and produces the full audio track. No signing required, no USDC cost.
The first creator to finish a side locks it — one song per side per battle.
Rap creator earns 0.60% of all backing volume on the battle and receives an IP Revenue NFT at settlement (win or lose).
Returns: { rap_id, battle_id, side, status: "generating", ... } — poll roaster_get_rap until status = "ready", then share track_url so the user can listen.
Confirm the battle, side, and angles with the user before calling.`,
      inputSchema: z.object({
        battle_id: z.string().describe("Battle ID from roaster_list_battles"),
        side: z.number().int().min(0).max(1).describe("0 = Side A, 1 = Side B"),
        angles: z.array(z.string().min(1)).min(1).max(6)
          .describe("Creative directions for the AI — e.g. ['wordplay', 'storytelling', 'braggadocio']. 1–6 items."),
      }),
      execute: async ({ battle_id, side, angles }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const { createRap } = await import("@/lib/roaster");
          return await createRap({ battle_id, side: side as 0 | 1, angles, creator_address: solanaAddress });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_back_side: tool({
      description: `Initiate backing a Roaster battle side with USDC. Returns a pendingRoasterBack marker — a wallet-signing card renders inline in chat and the user approves there.
Fee: 1.25% of amount (0.25% creator / 0.60% rap creators / 0.30% protocol / 0.10% referral).
Earlier backing earns a higher time-weight — the pool is parimutuel and time-weighted so backing sooner means a larger share of winnings.
IMPORTANT: Always call roaster_get_battle first to get live pool sizes, compute the payout estimate, confirm battle/side/amount with user, then call this.
Payout estimate if user's side wins: stake + (stake / side_pool) × other_pool. E.g. $10 on Side A ($40 pool) when Side B pool is $25 → $10 + (10/40 × $25) = $16.25.`,
      inputSchema: z.object({
        battle_id: z.string().describe("Battle ID — from roaster_list_battles or mentioned by the user"),
        side: z.number().int().min(0).max(1).describe("0 = Side A, 1 = Side B"),
        amount_usdc: z.number().positive().describe("USDC amount to back with"),
        referrer_address: z.string().optional().describe("Referrer's Solana address if the user was referred (earns 0.10%)"),
      }),
      execute: async ({ battle_id, side, amount_usdc, referrer_address }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const { backSide } = await import("@/lib/roaster");
          const data = await backSide({ battle_id, side: side as 0 | 1, amount_usdc, backer_address: solanaAddress, referrer_address });
          return { pendingRoasterBack: true, battle_id, side, amount_usdc, platform_fee_usdc: data.platform_fee_usdc, time_weight: data.time_weight, transaction: data.transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    roaster_create_battle: tool({
      description: `Create a new Roaster rap battle. Requires a non-refundable 10 USDC creation bond — a wallet-signing card renders inline in chat and the user approves there.
Returns { pendingRoasterBond: true, battle_id, bond_transaction } — signing card handles the on-chain bond payment, no redirect needed.
Creator earns 0.25% of all backing volume as a fee. Duration tiers: 15m / 6h / 24h.
IMPORTANT: Always confirm topic, side A name, side B name, and duration with the user before calling. The 10 USDC bond is non-refundable.`,
      inputSchema: z.object({
        topic: z.string().min(3).describe("The rap battle topic, e.g. 'AI vs Human Creativity'"),
        side_a_name: z.string().min(1).describe("Name for Side A, e.g. 'Robots'"),
        side_b_name: z.string().min(1).describe("Name for Side B, e.g. 'Humans'"),
        duration_tier: z.enum(["15m", "6h", "24h"]).describe("Battle duration: 15m (15 minutes), 6h (6 hours), 24h (24 hours)"),
      }),
      execute: async ({ topic, side_a_name, side_b_name, duration_tier }) => {
        if (!solanaAddress) return { error: "Solana wallet not connected" };
        try {
          const { createBattle } = await import("@/lib/roaster");
          const data = await createBattle({ topic, side_a_name, side_b_name, duration_tier, creator_address: solanaAddress });
          return { pendingRoasterBond: true, battle_id: data.battle_id, bond_transaction: data.bond_transaction, solanaAddress };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── Nosana GPU Cloud ───────────────────────────────────────────────────────

    nosana_list_deployments: tool({
      description: `List all Nosana GPU deployments for this account. Returns id, name, status (DRAFT/STARTING/RUNNING/STOPPING/STOPPED/ARCHIVED/ERROR/INSUFFICIENT_FUNDS), market, replicas, timeout, endpoint (if running), price_per_hour_usd, created_at. Use when the user asks to see their GPU deployments or workloads.`,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listDeployments } = await import("@/lib/nosana");
          return await listDeployments();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    nosana_get_deployment: tool({
      description: `Get detailed info for a single Nosana deployment by ID. Use when the user asks about a specific deployment, wants to check its status or endpoint, or after creating/starting/stopping one.`,
      inputSchema: z.object({
        id: z.string().describe("Deployment ID"),
      }),
      execute: async ({ id }) => {
        try {
          const { getDeployment } = await import("@/lib/nosana");
          return await getDeployment(id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    nosana_list_markets: tool({
      description: `List available Nosana GPU markets. Each market has address, name, gpu model, vram (GB), price_per_hour_usd, and type (PREMIUM or COMMUNITY). Use when the user wants to choose a GPU, compare prices, or deploy a workload.`,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listMarkets } = await import("@/lib/nosana");
          return await listMarkets();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    nosana_get_credits: tool({
      description: `Get Nosana credit balance. Returns assignedCredits, reservedCredits, settledCredits. Available = assigned - reserved - settled. Use when the user asks about their balance, credits, or whether they have enough to deploy.`,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { getCredits } = await import("@/lib/nosana");
          return await getCredits();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    nosana_create_deployment: tool({
      description: `Create AND start a Nosana GPU deployment. Builds a job definition from image + optional cmd/expose_port/env, then POSTs to create + auto-starts. No wallet signing — billing is credit-based. Returns the deployment object with id and status (will be STARTING).
Call nosana_list_markets first if the user hasn't specified a market address.
IMPORTANT: Confirm the Docker image, market, and estimated cost with the user before deploying. Cost = price_per_hour_usd × (timeout / 60) × replicas.`,
      inputSchema: z.object({
        name: z.string().min(1).describe("Friendly name for the deployment"),
        image: z.string().describe("Docker image, e.g. 'ollama/ollama:latest'"),
        market: z.string().describe("Market address from nosana_list_markets"),
        cmd: z.string().optional().describe("Entrypoint command to run inside the container, e.g. 'serve --model llama3'. Omit to use the image's default CMD."),
        expose_port: z.number().int().optional().describe("Port to expose publicly for HTTP access, e.g. 8080 for inference servers. Omit if no HTTP endpoint needed."),
        strategy: z.enum(["SIMPLE", "SIMPLE-EXTEND", "SCHEDULED", "INFINITE"]).default("SIMPLE").describe("Deployment strategy: SIMPLE (default, single run until timeout), SIMPLE-EXTEND (extends on activity), SCHEDULED (cron-based), INFINITE (never auto-stops)"),
        timeout: z.number().int().min(1).default(60).describe("Timeout in minutes before the deployment auto-stops (default 60). Ignored for INFINITE strategy."),
        replicas: z.number().int().min(1).default(1).describe("Number of parallel replicas (default 1)"),
        env: z.record(z.string(), z.string()).optional().describe("Environment variables to inject into the container, e.g. { MODEL: 'llama3', PORT: '8080' }"),
      }),
      execute: async ({ name, image, market, cmd, expose_port, strategy, timeout, replicas, env }) => {
        try {
          const { buildJobDefinition, createDeployment, startDeployment } = await import("@/lib/nosana");
          const job_definition = buildJobDefinition({ image, command: cmd, expose_port, env });
          const dep = await createDeployment({
            name,
            market,
            timeout: timeout ?? 60,
            replicas: replicas ?? 1,
            strategy: strategy ?? "SIMPLE",
            job_definition,
          });
          return await startDeployment(dep.id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    nosana_start_deployment: tool({
      description: `Start or restart a Nosana deployment that is in DRAFT or STOPPED state. Transitions it to STARTING → RUNNING. Use when the user wants to restart a stopped deployment or launch a draft one. Do NOT use for new deployments — use nosana_create_deployment instead.`,
      inputSchema: z.object({
        id: z.string().describe("Deployment ID to start/restart"),
      }),
      execute: async ({ id }) => {
        try {
          const { startDeployment } = await import("@/lib/nosana");
          return await startDeployment(id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    nosana_get_spending_history: tool({
      description: `Get Nosana credit spending history — a list of transactions showing how much was spent on each deployment and when. Use when the user asks about spending, usage costs, or billing history. Optionally filter by date range.`,
      inputSchema: z.object({
        from: z.string().optional().describe("ISO date string — earliest date to include, e.g. '2025-01-01'"),
        to: z.string().optional().describe("ISO date string — latest date to include, e.g. '2025-12-31'"),
        limit: z.number().int().min(1).optional().describe("Max number of transactions to return"),
      }),
      execute: async ({ from, to, limit }) => {
        try {
          const { getSpendingHistory } = await import("@/lib/nosana");
          return await getSpendingHistory({ from, to, limit });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    nosana_stop_deployment: tool({
      description: `Stop a running Nosana deployment. Transitions RUNNING → STOPPING → STOPPED. The deployment can be restarted later with nosana_start_deployment. Use when the user wants to pause or stop a GPU workload.`,
      inputSchema: z.object({
        id: z.string().describe("Deployment ID to stop"),
      }),
      execute: async ({ id }) => {
        try {
          const { stopDeployment } = await import("@/lib/nosana");
          return await stopDeployment(id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    nosana_archive_deployment: tool({
      description: `Archive a Nosana deployment (DRAFT/STOPPED/ERROR only). Permanent — cannot be restarted after archiving. Use when the user wants to permanently delete/retire a deployment.
IMPORTANT: Confirm with the user before archiving — this is irreversible.`,
      inputSchema: z.object({
        id: z.string().describe("Deployment ID to archive"),
      }),
      execute: async ({ id }) => {
        try {
          const { archiveDeployment } = await import("@/lib/nosana");
          return await archiveDeployment(id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    claim_velvet_removed_tokens: tool({
      description:
        "Claim the user's proportionate share of tokens that were removed from a Velvet portfolio vault. Use when the user mentions tokens were excluded or removed from a vault they hold.",
      inputSchema: z.object({
        token_exclusion_manager: z.string().describe("TokenExclusionManager contract address from get_velvet_portfolios"),
        start_id: z.number().int().min(0).describe("Starting exclusion event ID to claim from"),
        end_id: z.number().int().min(0).describe("Ending exclusion event ID to claim to (inclusive)"),
      }),
      execute: async ({ token_exclusion_manager, start_id, end_id }) => {
        if (!walletAddress) return { error: "Wallet not connected" };
        try {
          const { encodeClaimRemovedTokens } = await import("@/lib/velvet");
          const tx = encodeClaimRemovedTokens(token_exclusion_manager, walletAddress, start_id, end_id);
          return { pendingClaim: true, user: walletAddress, start_id, end_id, tx };
        } catch (err: any) {
          return { error: err?.message ?? "Failed to encode claim" };
        }
      },
    }),

    // ── SpherePay — B2B Global Payments ──────────────────────────────────────

    spherepay_list_customers: tool({
      description: "List SpherePay customers with their KYC/KYB verification status. Use to see who is onboarded.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
        page: z.number().int().min(1).optional().describe("Page number"),
      }),
      execute: async ({ limit, page }) => {
        try {
          const { listCustomers } = await import("@/lib/spherepay");
          return await listCustomers({ limit, page });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_create_customer: tool({
      description: "Create a new individual or business customer in SpherePay for KYC/KYB onboarding. Individual requires: email, phone, address, firstName, lastName. Business requires: email, phone, addresses (registered + operating), businessInformation.",
      inputSchema: z.object({
        type: z.enum(["individual", "business"]).describe("Customer type"),
        email: z.string().email().describe("Customer email"),
        phone: z.string().describe("Phone in E.164 format e.g. +14155550123"),
        firstName: z.string().optional().describe("First name (individual only)"),
        lastName: z.string().optional().describe("Last name (individual only)"),
        address: z.object({
          line1: z.string(),
          city: z.string(),
          country: z.string().describe("ISO3166-1 Alpha-3 e.g. USA"),
          state: z.string().optional(),
          postalCode: z.string().optional(),
        }).optional().describe("Address (individual)"),
        businessLegalName: z.string().optional().describe("Legal name (business)"),
      }),
      execute: async ({ type, email, phone, firstName, lastName, address, businessLegalName }) => {
        try {
          const { createCustomer } = await import("@/lib/spherepay");
          const body: any = { type, email, phone };
          if (type === "individual") {
            if (firstName) body.firstName = firstName;
            if (lastName) body.lastName = lastName;
            if (address) body.address = address;
          }
          if (type === "business" && businessLegalName) {
            body.businessInformation = { legalName: businessLegalName };
          }
          return await createCustomer(body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_get_customer: tool({
      description: "Get a SpherePay customer by ID — returns full profile including KYC/KYB verification status, criteria, and what's still needed.",
      inputSchema: z.object({
        customer_id: z.string().describe("Customer ID e.g. customer_abc123"),
      }),
      execute: async ({ customer_id }) => {
        try {
          const { getCustomer } = await import("@/lib/spherepay");
          return await getCustomer(customer_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_create_transfer: tool({
      description: "Create a SpherePay on-ramp or off-ramp transfer. On-ramp: bank_account → wallet (fiat → crypto). Off-ramp: wallet → bank_account (crypto → fiat). Always get a quote first with spherepay_create_quote if the user wants a locked rate. Requires the customer to be KYC/KYB approved.",
      inputSchema: z.object({
        amount: z.string().describe("Amount as decimal string e.g. '5000.00'"),
        customer: z.string().describe("Customer ID"),
        source_type: z.enum(["bank_account", "wallet"]).describe("Source instrument type"),
        source_id: z.string().describe("Source instrument ID"),
        source_currency: z.string().describe("Source currency e.g. usd, usdc, brl"),
        source_network: z.string().describe("Source rail/network e.g. ach, wire, sepa, pix, sol, ethereum"),
        destination_type: z.enum(["bank_account", "wallet"]).describe("Destination instrument type"),
        destination_id: z.string().describe("Destination instrument ID"),
        destination_currency: z.string().describe("Destination currency e.g. usdc, usd, eur"),
        destination_network: z.string().describe("Destination rail/network e.g. sol, ethereum, ach, sepa"),
        quote_id: z.string().optional().describe("Rate-locked quote ID from spherepay_create_quote"),
      }),
      execute: async ({ amount, customer, source_type, source_id, source_currency, source_network, destination_type, destination_id, destination_currency, destination_network, quote_id }) => {
        try {
          const { createTransfer } = await import("@/lib/spherepay");
          const body: any = {
            amount,
            customer,
            source: { type: source_type, id: source_id, currency: source_currency, network: source_network },
            destination: { type: destination_type, id: destination_id, currency: destination_currency, network: destination_network },
          };
          if (quote_id) body.quoteId = quote_id;
          return await createTransfer(body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_list_transfers: tool({
      description: "List SpherePay on-ramp/off-ramp transfers. Optionally filter by customer ID.",
      inputSchema: z.object({
        customer_id: z.string().optional().describe("Filter by customer ID"),
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).optional(),
      }),
      execute: async ({ customer_id, limit, page }) => {
        try {
          const { listTransfers } = await import("@/lib/spherepay");
          return await listTransfers({ customerId: customer_id, limit, page });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_get_transfer: tool({
      description: "Get the status and deposit instructions for a specific SpherePay transfer.",
      inputSchema: z.object({
        transfer_id: z.string().describe("Transfer ID e.g. transfer_abc123"),
      }),
      execute: async ({ transfer_id }) => {
        try {
          const { getTransfer } = await import("@/lib/spherepay");
          return await getTransfer(transfer_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_cancel_transfer: tool({
      description: "Cancel an unfunded pending SpherePay transfer. Only works on transfers that have not been funded yet.",
      inputSchema: z.object({
        transfer_id: z.string().describe("Transfer ID to cancel"),
      }),
      execute: async ({ transfer_id }) => {
        try {
          const { cancelTransfer } = await import("@/lib/spherepay");
          return await cancelTransfer(transfer_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_create_quote: tool({
      description: "Create a rate-locked quote for a SpherePay transfer. Lock the FX rate before executing — valid for a short window. Use before spherepay_create_transfer when the user wants a guaranteed rate.",
      inputSchema: z.object({
        customer: z.string().describe("Customer ID"),
        source_currency: z.string().describe("Source currency e.g. usd, usdc"),
        source_network: z.string().describe("Source network/rail e.g. ach, sol"),
        destination_currency: z.string().describe("Destination currency e.g. usdc, usd"),
        destination_network: z.string().describe("Destination network/rail e.g. sol, ach"),
        amount: z.string().describe("Amount as decimal string"),
        amount_side: z.enum(["source", "destination"]).default("source").describe("Whether amount is the source or destination side"),
      }),
      execute: async ({ customer, source_currency, source_network, destination_currency, destination_network, amount, amount_side }) => {
        try {
          const { createQuote } = await import("@/lib/spherepay");
          return await createQuote({ customer, sourceCurrency: source_currency, sourceNetwork: source_network, destinationCurrency: destination_currency, destinationNetwork: destination_network, amount, amountSide: amount_side });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_list_bank_accounts: tool({
      description: "List registered bank accounts for a SpherePay customer.",
      inputSchema: z.object({
        customer_id: z.string().optional().describe("Filter by customer ID"),
      }),
      execute: async ({ customer_id }) => {
        try {
          const { listBankAccounts } = await import("@/lib/spherepay");
          return await listBankAccounts(customer_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_register_bank_account: tool({
      description: "Register a bank account for a SpherePay customer to enable fiat transfers. Customer must have at least one approved verification profile. Supports ACH (US), Wire (US), SEPA (EUR), PIX (BRL).",
      inputSchema: z.object({
        customer: z.string().describe("Customer ID"),
        currency: z.string().describe("Currency e.g. usd, eur, brl"),
        network: z.string().describe("Rail e.g. ach, wire, sepa, pix"),
        account_number: z.string().optional().describe("Bank account number"),
        routing_number: z.string().optional().describe("Routing number (ACH/Wire)"),
        iban: z.string().optional().describe("IBAN (SEPA)"),
        pix_key: z.string().optional().describe("PIX key (Brazil)"),
        bank_name: z.string().optional().describe("Bank name"),
        account_holder_name: z.string().optional().describe("Account holder name"),
        country: z.string().optional().describe("ISO3166-1 Alpha-3 country code"),
      }),
      execute: async ({ customer, currency, network, account_number, routing_number, iban, pix_key, bank_name, account_holder_name, country }) => {
        try {
          const { registerBankAccount } = await import("@/lib/spherepay");
          const body: any = { customer, currency, network };
          if (account_number) body.accountNumber = account_number;
          if (routing_number) body.routingNumber = routing_number;
          if (iban) body.iban = iban;
          if (pix_key) body.pixKey = pix_key;
          if (bank_name) body.bankName = bank_name;
          if (account_holder_name) body.accountHolderName = account_holder_name;
          if (country) body.country = country;
          return await registerBankAccount(body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_list_wallets: tool({
      description: "List registered crypto wallets for a SpherePay customer.",
      inputSchema: z.object({
        customer_id: z.string().optional().describe("Filter by customer ID"),
      }),
      execute: async ({ customer_id }) => {
        try {
          const { listWallets } = await import("@/lib/spherepay");
          return await listWallets(customer_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_register_wallet: tool({
      description: "Register a crypto wallet address for a SpherePay customer to receive stablecoins (USDC, USDT, EURC) on supported networks (sol, ethereum, polygon, etc.).",
      inputSchema: z.object({
        customer: z.string().describe("Customer ID"),
        address: z.string().describe("On-chain wallet address"),
        network: z.string().describe("Blockchain network e.g. sol, ethereum, polygon, arbitrum"),
        currency: z.string().describe("Stablecoin currency e.g. usdc, usdt, eurc"),
      }),
      execute: async ({ customer, address, network, currency }) => {
        try {
          const { registerWallet } = await import("@/lib/spherepay");
          return await registerWallet({ customer, address, network, currency });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_create_virtual_account: tool({
      description: "Create an Onramper virtual bank account for a SpherePay customer. Each customer gets a dedicated virtual USD/EUR bank account (account+routing or SEPA). When fiat is deposited it auto-converts to stablecoins and sends to the customer's wallet — no per-payment API call needed. Ideal for payroll, payment acceptance, and recurring on-ramp flows.",
      inputSchema: z.object({
        customer: z.string().describe("Customer ID"),
        destination_wallet_id: z.string().describe("Wallet ID to receive stablecoins"),
        destination_currency: z.string().describe("Stablecoin to receive e.g. usdc"),
        destination_network: z.string().describe("Network to receive on e.g. sol, ethereum"),
        source_currency: z.string().default("usd").describe("Fiat currency for deposits e.g. usd, eur"),
        source_network: z.string().default("ach").describe("Rail for deposits e.g. ach, wire, sepa"),
      }),
      execute: async ({ customer, destination_wallet_id, destination_currency, destination_network, source_currency, source_network }) => {
        try {
          const { createVirtualAccount } = await import("@/lib/spherepay");
          return await createVirtualAccount({ customer, destination: { walletId: destination_wallet_id, currency: destination_currency, network: destination_network }, source: { currency: source_currency, network: source_network } });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_list_virtual_accounts: tool({
      description: "List all Onramper virtual bank accounts — dedicated fiat deposit accounts that auto-convert to stablecoins.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listVirtualAccounts } = await import("@/lib/spherepay");
          return await listVirtualAccounts();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_create_offloader_wallet: tool({
      description: "Create an Offloader Wallet for a SpherePay customer. Gives a dedicated on-chain address that automatically converts incoming stablecoins to fiat bank payouts — no per-payment API call. Ideal for recurring off-ramp (payroll disbursement, recurring settlements).",
      inputSchema: z.object({
        customer: z.string().describe("Customer ID"),
        source_currency: z.string().describe("Stablecoin to receive e.g. usdc"),
        source_network: z.string().describe("Network e.g. sol, ethereum"),
        destination_bank_account_id: z.string().describe("Bank account ID to receive fiat"),
        destination_currency: z.string().describe("Fiat currency to pay out e.g. usd, eur"),
        destination_network: z.string().describe("Payout rail e.g. ach, wire, sepa"),
      }),
      execute: async ({ customer, source_currency, source_network, destination_bank_account_id, destination_currency, destination_network }) => {
        try {
          const { createOffloaderWallet } = await import("@/lib/spherepay");
          return await createOffloaderWallet({ customer, source: { currency: source_currency, network: source_network }, destination: { bankAccountId: destination_bank_account_id, currency: destination_currency, network: destination_network } });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_list_offloader_wallets: tool({
      description: "List all Offloader Wallets — dedicated crypto addresses that automatically convert stablecoins to fiat bank payouts.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listOffloaderWallets } = await import("@/lib/spherepay");
          return await listOffloaderWallets();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_get_offloader_wallet: tool({
      description: "Get a specific SpherePay Offloader Wallet by ID.",
      inputSchema: z.object({
        offloader_wallet_id: z.string().describe("Offloader wallet ID"),
      }),
      execute: async ({ offloader_wallet_id }) => {
        try {
          const { getOffloaderWallet } = await import("@/lib/spherepay");
          return await getOffloaderWallet(offloader_wallet_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_get_virtual_account: tool({
      description: "Get a specific SpherePay Onramper virtual bank account by ID — shows the account/routing numbers and deposit instructions.",
      inputSchema: z.object({
        virtual_account_id: z.string().describe("Virtual account ID"),
      }),
      execute: async ({ virtual_account_id }) => {
        try {
          const { getVirtualAccount } = await import("@/lib/spherepay");
          return await getVirtualAccount(virtual_account_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_get_quote: tool({
      description: "Get a specific SpherePay rate-locked quote by ID — check its status (active/used/expired) and the locked exchange rate.",
      inputSchema: z.object({
        quote_id: z.string().describe("Quote ID"),
      }),
      execute: async ({ quote_id }) => {
        try {
          const { getQuote } = await import("@/lib/spherepay");
          return await getQuote(quote_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_list_business_reps: tool({
      description: "List all business representatives (UBOs, signers, control persons) for a SpherePay business customer. Required to complete KYB — every UBO with ≥25% ownership must be listed and verified.",
      inputSchema: z.object({
        customer_id: z.string().describe("Business customer ID"),
      }),
      execute: async ({ customer_id }) => {
        try {
          const { listBusinessReps } = await import("@/lib/spherepay");
          return await listBusinessReps(customer_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_add_business_rep: tool({
      description: "Add a business representative or UBO (Ultimate Beneficial Owner) to a SpherePay business customer for KYB verification. Every individual who owns ≥25% of the business must be added. Required fields: customer, firstName, lastName, email, dateOfBirth, address. Optionally set ownershipPercentage, isControlPerson, isSigner.",
      inputSchema: z.object({
        customer: z.string().describe("Business customer ID"),
        first_name: z.string().describe("First name"),
        last_name: z.string().describe("Last name"),
        email: z.string().email().describe("Email address"),
        date_of_birth: z.string().describe("Date of birth YYYY-MM-DD"),
        address_line1: z.string().describe("Street address line 1"),
        address_city: z.string().describe("City"),
        address_country: z.string().describe("ISO3166-1 Alpha-3 country code e.g. USA"),
        address_state: z.string().optional().describe("State/province code"),
        address_postal_code: z.string().optional().describe("Postal code"),
        ownership_percentage: z.number().min(0).max(100).optional().describe("Ownership percentage (0–100)"),
        is_control_person: z.boolean().optional().describe("Is a control person (CEO, CFO, etc.)"),
        is_signer: z.boolean().optional().describe("Is authorized to sign on behalf of the business"),
        title: z.string().optional().describe("Job title e.g. CEO"),
      }),
      execute: async ({ customer, first_name, last_name, email, date_of_birth, address_line1, address_city, address_country, address_state, address_postal_code, ownership_percentage, is_control_person, is_signer, title }) => {
        try {
          const { createBusinessRep } = await import("@/lib/spherepay");
          const body: any = {
            customer,
            firstName: first_name,
            lastName: last_name,
            email,
            dateOfBirth: date_of_birth,
            address: { line1: address_line1, city: address_city, country: address_country, ...(address_state ? { state: address_state } : {}), ...(address_postal_code ? { postalCode: address_postal_code } : {}) },
          };
          if (ownership_percentage != null) body.ownershipPercentage = ownership_percentage;
          if (is_control_person != null) body.isControlPerson = is_control_person;
          if (is_signer != null) body.isSigner = is_signer;
          if (title) body.title = title;
          return await createBusinessRep(body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_upload_document: tool({
      description: "Upload a KYC or KYB identity document for a SpherePay customer. Document types include: identity_document (passport, driver's license), incorporation_cert_document, shareholder_registry_document, proof_of_address_document, proof_of_nature_of_business_document, w9_document, w8_ben_document, bank_statement_document. File must be base64-encoded.",
      inputSchema: z.object({
        customer_id: z.string().describe("Customer ID"),
        document_type: z.string().describe("Document type e.g. identity_document, incorporation_cert_document, proof_of_address_document, w9_document"),
        file_base64: z.string().describe("Base64-encoded file content"),
        file_name: z.string().describe("File name including extension e.g. passport.pdf"),
        mime_type: z.string().describe("MIME type e.g. application/pdf, image/jpeg, image/png"),
      }),
      execute: async ({ customer_id, document_type, file_base64, file_name, mime_type }) => {
        try {
          const { uploadDocument } = await import("@/lib/spherepay");
          return await uploadDocument(customer_id, document_type, file_base64, file_name, mime_type);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_create_kyc_link: tool({
      description: "Create a SpherePay hosted KYC onboarding link for a customer. Redirects the customer to complete identity verification in Sphere's hosted UI — no custom UI needed. Use this when you want to onboard a customer quickly without API-based document submission.",
      inputSchema: z.object({
        type: z.enum(["individual", "business"]).describe("Customer type"),
        email: z.string().email().describe("Customer email"),
      }),
      execute: async ({ type, email }) => {
        try {
          const { createCustomerViaLink } = await import("@/lib/spherepay");
          return await createCustomerViaLink({ type, email });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_update_customer: tool({
      description: "Update a SpherePay customer's contact information — email, phone, or address. Individual customers only.",
      inputSchema: z.object({
        customer_id: z.string().describe("Customer ID"),
        email: z.string().email().optional().describe("New email address"),
        phone: z.string().optional().describe("New phone in E.164 format"),
        address_line1: z.string().optional(),
        address_city: z.string().optional(),
        address_country: z.string().optional().describe("ISO3166-1 Alpha-3"),
        address_state: z.string().optional(),
        address_postal_code: z.string().optional(),
      }),
      execute: async ({ customer_id, email, phone, address_line1, address_city, address_country, address_state, address_postal_code }) => {
        try {
          const { updateCustomer } = await import("@/lib/spherepay");
          const body: any = {};
          if (email) body.email = email;
          if (phone) body.phone = phone;
          if (address_line1 || address_city || address_country) {
            body.address = { ...(address_line1 ? { line1: address_line1 } : {}), ...(address_city ? { city: address_city } : {}), ...(address_country ? { country: address_country } : {}), ...(address_state ? { state: address_state } : {}), ...(address_postal_code ? { postalCode: address_postal_code } : {}) };
          }
          return await updateCustomer(customer_id, body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_get_bank_account: tool({
      description: "Get a specific SpherePay bank account by ID — shows account details, currency, rail, and verification status.",
      inputSchema: z.object({
        bank_account_id: z.string().describe("Bank account ID"),
      }),
      execute: async ({ bank_account_id }) => {
        try {
          const { getBankAccount } = await import("@/lib/spherepay");
          return await getBankAccount(bank_account_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_delete_bank_account: tool({
      description: "Delete a registered SpherePay bank account. Only unlinked accounts (not used in active transfers) can be deleted.",
      inputSchema: z.object({
        bank_account_id: z.string().describe("Bank account ID to delete"),
      }),
      execute: async ({ bank_account_id }) => {
        try {
          const { deleteBankAccount } = await import("@/lib/spherepay");
          return await deleteBankAccount(bank_account_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_get_wallet: tool({
      description: "Get a specific SpherePay registered crypto wallet by ID.",
      inputSchema: z.object({
        wallet_id: z.string().describe("Wallet ID"),
      }),
      execute: async ({ wallet_id }) => {
        try {
          const { getWallet } = await import("@/lib/spherepay");
          return await getWallet(wallet_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_delete_wallet: tool({
      description: "Delete a registered SpherePay crypto wallet from a customer's profile.",
      inputSchema: z.object({
        wallet_id: z.string().describe("Wallet ID to delete"),
      }),
      execute: async ({ wallet_id }) => {
        try {
          const { deleteWallet } = await import("@/lib/spherepay");
          return await deleteWallet(wallet_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_list_quotes: tool({
      description: "List SpherePay rate-locked quotes, optionally filtered by customer or status (active/used/expired).",
      inputSchema: z.object({
        customer_id: z.string().optional().describe("Filter by customer ID"),
        status: z.enum(["active", "used", "expired"]).optional().describe("Filter by quote status"),
      }),
      execute: async ({ customer_id, status }) => {
        try {
          const { listQuotes } = await import("@/lib/spherepay");
          return await listQuotes({ customerId: customer_id, status });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_deactivate_virtual_account: tool({
      description: "Deactivate a SpherePay Onramper virtual bank account so it no longer accepts deposits. Use when a customer off-boards or changes their payment instrument.",
      inputSchema: z.object({
        virtual_account_id: z.string().describe("Virtual account ID to deactivate"),
      }),
      execute: async ({ virtual_account_id }) => {
        try {
          const { deactivateVirtualAccount } = await import("@/lib/spherepay");
          return await deactivateVirtualAccount(virtual_account_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_reactivate_virtual_account: tool({
      description: "Reactivate a previously deactivated SpherePay Onramper virtual bank account so it resumes accepting deposits.",
      inputSchema: z.object({
        virtual_account_id: z.string().describe("Virtual account ID to reactivate"),
      }),
      execute: async ({ virtual_account_id }) => {
        try {
          const { reactivateVirtualAccount } = await import("@/lib/spherepay");
          return await reactivateVirtualAccount(virtual_account_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_get_business_rep: tool({
      description: "Get a specific SpherePay business representative or UBO by ID — shows their KYC verification status and criteria.",
      inputSchema: z.object({
        rep_id: z.string().describe("Business representative ID"),
      }),
      execute: async ({ rep_id }) => {
        try {
          const { getBusinessRep } = await import("@/lib/spherepay");
          return await getBusinessRep(rep_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_delete_business_rep: tool({
      description: "Remove a business representative or UBO from a SpherePay business customer before KYB is submitted.",
      inputSchema: z.object({
        rep_id: z.string().describe("Business representative ID to remove"),
      }),
      execute: async ({ rep_id }) => {
        try {
          const { deleteBusinessRep } = await import("@/lib/spherepay");
          return await deleteBusinessRep(rep_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_update_business_rep: tool({
      description: "Update a business representative or UBO's information before KYB is submitted — e.g. correct a name, date of birth, or ownership percentage.",
      inputSchema: z.object({
        rep_id: z.string().describe("Business representative ID"),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().email().optional(),
        date_of_birth: z.string().optional().describe("YYYY-MM-DD"),
        ownership_percentage: z.number().min(0).max(100).optional(),
        is_control_person: z.boolean().optional(),
        is_signer: z.boolean().optional(),
        title: z.string().optional(),
      }),
      execute: async ({ rep_id, first_name, last_name, email, date_of_birth, ownership_percentage, is_control_person, is_signer, title }) => {
        try {
          const { updateBusinessRep } = await import("@/lib/spherepay");
          const body: any = {};
          if (first_name) body.firstName = first_name;
          if (last_name) body.lastName = last_name;
          if (email) body.email = email;
          if (date_of_birth) body.dateOfBirth = date_of_birth;
          if (ownership_percentage != null) body.ownershipPercentage = ownership_percentage;
          if (is_control_person != null) body.isControlPerson = is_control_person;
          if (is_signer != null) body.isSigner = is_signer;
          if (title) body.title = title;
          return await updateBusinessRep(rep_id, body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_regenerate_kyc_link: tool({
      description: "Regenerate a hosted KYC link for an existing SpherePay customer who was created via the KYC link flow. Use when the original link has expired.",
      inputSchema: z.object({
        customer_id: z.string().describe("Customer ID"),
      }),
      execute: async ({ customer_id }) => {
        try {
          const { regenerateKycLink } = await import("@/lib/spherepay");
          return await regenerateKycLink(customer_id);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_update_bank_account: tool({
      description: "Update a SpherePay bank account's payment rail settings — e.g. change the supported networks on a non-SWIFT account, or set the intermediary BIC on a USD SWIFT account.",
      inputSchema: z.object({
        bank_account_id: z.string().describe("Bank account ID"),
        networks: z.array(z.string()).optional().describe("New list of supported network codes e.g. ['ach', 'wire']"),
        intermediary_bic: z.string().optional().describe("Intermediary BIC for USD SWIFT accounts"),
      }),
      execute: async ({ bank_account_id, networks, intermediary_bic }) => {
        try {
          const { updateBankAccount } = await import("@/lib/spherepay");
          const body: any = {};
          if (networks) body.networks = networks;
          if (intermediary_bic) body.intermediaryBic = intermediary_bic;
          return await updateBankAccount(bank_account_id, body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_update_offloader_wallet: tool({
      description: "Update a SpherePay Offloader Wallet's bank destination — change the bank account, fiat currency, or payout rail it auto-converts to.",
      inputSchema: z.object({
        offloader_wallet_id: z.string().describe("Offloader wallet ID"),
        destination_bank_account_id: z.string().optional().describe("New bank account ID"),
        destination_currency: z.string().optional().describe("New fiat currency e.g. usd, eur"),
        destination_network: z.string().optional().describe("New payout rail e.g. ach, sepa"),
      }),
      execute: async ({ offloader_wallet_id, destination_bank_account_id, destination_currency, destination_network }) => {
        try {
          const { updateOffloaderWallet } = await import("@/lib/spherepay");
          const body: any = {};
          if (destination_bank_account_id || destination_currency || destination_network) {
            body.destination = { ...(destination_bank_account_id ? { bankAccountId: destination_bank_account_id } : {}), ...(destination_currency ? { currency: destination_currency } : {}), ...(destination_network ? { network: destination_network } : {}) };
          }
          return await updateOffloaderWallet(offloader_wallet_id, body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_update_quote_status: tool({
      description: "Mark a SpherePay rate-locked quote as used or expired. Only active quotes can be updated. Use 'expired' to manually invalidate a quote you no longer intend to use.",
      inputSchema: z.object({
        quote_id: z.string().describe("Quote ID"),
        status: z.enum(["used", "expired"]).describe("New status"),
      }),
      execute: async ({ quote_id, status }) => {
        try {
          const { updateQuoteStatus } = await import("@/lib/spherepay");
          return await updateQuoteStatus(quote_id, status);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    spherepay_update_virtual_account: tool({
      description: "Update a SpherePay Onramper virtual account's destination wallet, stablecoin network, or fee configuration.",
      inputSchema: z.object({
        virtual_account_id: z.string().describe("Virtual account ID"),
        destination_wallet_id: z.string().optional().describe("New destination wallet ID"),
        destination_currency: z.string().optional().describe("New stablecoin currency e.g. usdc"),
        destination_network: z.string().optional().describe("New network e.g. sol, ethereum"),
      }),
      execute: async ({ virtual_account_id, destination_wallet_id, destination_currency, destination_network }) => {
        try {
          const { updateVirtualAccount } = await import("@/lib/spherepay");
          const body: any = {};
          if (destination_wallet_id || destination_currency || destination_network) {
            body.destination = { ...(destination_wallet_id ? { walletId: destination_wallet_id } : {}), ...(destination_currency ? { currency: destination_currency } : {}), ...(destination_network ? { network: destination_network } : {}) };
          }
          return await updateVirtualAccount(virtual_account_id, body);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── Fuze Finance ──────────────────────────────────────────────────────────

    fuze_create_user: tool({
      description: "Create a new Fuze end-user (CONSUMER) or org user. Returns the user record. KYC/KYB must be completed before they can transact.",
      inputSchema: z.object({
        orgUserId: z.string().describe("Your system's unique identifier for this user"),
        userType: z.enum(["USER", "ORG_USER"]).describe("USER for end-customers, ORG_USER for internal/operational accounts"),
        email: z.string().optional().describe("User email address"),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        phoneNumber: z.string().optional(),
        country: z.string().optional().describe("ISO 3166-1 alpha-2 country code"),
      }),
      execute: async (args) => {
        try {
          const { createUser } = await import("@/lib/fuze");
          return await createUser(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_user: tool({
      description: "Get a Fuze user by their orgUserId, including KYC status.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { getUser } = await import("@/lib/fuze");
          return await getUser(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_users: tool({
      description: "List Fuze users with optional pagination.",
      inputSchema: z.object({
        page: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { listUsers } = await import("@/lib/fuze");
          return await listUsers(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_kyc_link: tool({
      description: "Generate a Fuze-hosted KYC link for a user to complete identity verification.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { getUserKycLink } = await import("@/lib/fuze");
          return await getUserKycLink(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_user_balance: tool({
      description: "Get all wallet and account balances for a Fuze user across currencies.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { getUserBalance } = await import("@/lib/fuze");
          return await getUserBalance(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_update_user: tool({
      description: "Update a Fuze user's profile fields (email, name, phone, country, etc.).",
      inputSchema: z.object({
        orgUserId: z.string(),
        fields: z.record(z.string(), z.unknown()).describe("Fields to update, e.g. { email, firstName, lastName, phoneNumber, country }"),
      }),
      execute: async ({ orgUserId, fields }) => {
        try {
          const { updateUser } = await import("@/lib/fuze");
          return await updateUser(orgUserId, fields);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_counterparty: tool({
      description: "Register a counterparty (external individual or business) on Fuze. SELF = user's own external account, THIRD_PARTY = someone else.",
      inputSchema: z.object({
        orgUserId: z.string(),
        type: z.enum(["SELF", "THIRD_PARTY"]),
        name: z.string().optional(),
        legalName: z.string().optional(),
        email: z.string().optional(),
        country: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { createCounterparty } = await import("@/lib/fuze");
          return await createCounterparty(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_counterparty: tool({
      description: "Get a specific Fuze counterparty by ID.",
      inputSchema: z.object({ counterpartyId: z.string() }),
      execute: async ({ counterpartyId }) => {
        try {
          const { getCounterparty } = await import("@/lib/fuze");
          return await getCounterparty(counterpartyId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_counterparties: tool({
      description: "List all counterparties for a Fuze user.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { listCounterparties } = await import("@/lib/fuze");
          return await listCounterparties(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_internal_wallet: tool({
      description: "Create a Fuze-hosted crypto wallet for a user. Each wallet is per-currency and per-network and gets a unique deposit address.",
      inputSchema: z.object({
        orgUserId: z.string(),
        currency: z.string().describe("e.g. USDT, USDC, BTC, ETH"),
        network: z.string().describe("e.g. ethereum, tron, bsc, polygon, solana"),
      }),
      execute: async (args) => {
        try {
          const { createInternalWallet } = await import("@/lib/fuze");
          return await createInternalWallet(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_internal_wallets: tool({
      description: "List all Fuze-hosted crypto wallets for a user.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { listInternalWallets } = await import("@/lib/fuze");
          return await listInternalWallets(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_internal_wallet: tool({
      description: "Get a specific Fuze-hosted crypto wallet by walletId, including balance and deposit address.",
      inputSchema: z.object({ walletId: z.string() }),
      execute: async ({ walletId }) => {
        try {
          const { getInternalWallet } = await import("@/lib/fuze");
          return await getInternalWallet(walletId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_external_wallets: tool({
      description: "List all registered external crypto withdrawal wallets for a counterparty.",
      inputSchema: z.object({ counterpartyId: z.string() }),
      execute: async ({ counterpartyId }) => {
        try {
          const { listExternalWallets } = await import("@/lib/fuze");
          return await listExternalWallets(counterpartyId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_delete_external_wallet: tool({
      description: "Remove a registered external crypto wallet from a Fuze counterparty.",
      inputSchema: z.object({ walletId: z.string() }),
      execute: async ({ walletId }) => {
        try {
          const { deleteExternalWallet } = await import("@/lib/fuze");
          return await deleteExternalWallet(walletId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_register_external_wallet: tool({
      description: "Register an external crypto wallet address as a withdrawal destination for a counterparty.",
      inputSchema: z.object({
        counterpartyId: z.string(),
        currency: z.string(),
        network: z.string(),
        address: z.string(),
        type: z.enum(["SELF", "THIRD_PARTY"]).optional(),
        memo: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { registerExternalWallet } = await import("@/lib/fuze");
          return await registerExternalWallet(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_internal_account: tool({
      description: "Create a Fuze-hosted fiat account for a user. Returns deposit instructions (virtual IBAN, bank details).",
      inputSchema: z.object({
        orgUserId: z.string(),
        currency: z.string().describe("e.g. AED, USD, EUR, GBP"),
      }),
      execute: async (args) => {
        try {
          const { createInternalAccount } = await import("@/lib/fuze");
          return await createInternalAccount(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_internal_accounts: tool({
      description: "List all Fuze-hosted fiat accounts for a user.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { listInternalAccounts } = await import("@/lib/fuze");
          return await listInternalAccounts(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_internal_account: tool({
      description: "Get a specific Fuze-hosted fiat account by accountId, including balance and deposit instructions.",
      inputSchema: z.object({ accountId: z.string() }),
      execute: async ({ accountId }) => {
        try {
          const { getInternalAccount } = await import("@/lib/fuze");
          return await getInternalAccount(accountId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_external_accounts: tool({
      description: "List all registered external bank accounts for a counterparty.",
      inputSchema: z.object({ counterpartyId: z.string() }),
      execute: async ({ counterpartyId }) => {
        try {
          const { listExternalAccounts } = await import("@/lib/fuze");
          return await listExternalAccounts(counterpartyId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_register_external_account: tool({
      description: "Register an external bank account as a payout destination for a counterparty.",
      inputSchema: z.object({
        counterpartyId: z.string(),
        currency: z.string(),
        beneficiaryName: z.string(),
        accountNumber: z.string(),
        bankName: z.string(),
        country: z.string(),
        routingCode: z.string().optional(),
        iban: z.string().optional(),
        swiftBic: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { registerExternalAccount } = await import("@/lib/fuze");
          return await registerExternalAccount(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_internal_transfer: tool({
      description: "Transfer funds between two Fuze users (same currency, internal, no fees).",
      inputSchema: z.object({
        fromOrgUserId: z.string(),
        toOrgUserId: z.string(),
        amount: z.number().positive(),
        currency: z.string(),
        description: z.string().optional(),
        clientOrderId: z.string().optional().describe("Idempotency key"),
      }),
      execute: async (args) => {
        try {
          const { createInternalTransfer } = await import("@/lib/fuze");
          return await createInternalTransfer(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_external_transfer: tool({
      description: "Transfer funds from a Fuze user to an external wallet or bank account (outbound/payout).",
      inputSchema: z.object({
        orgUserId: z.string(),
        counterpartyId: z.string(),
        externalAccountId: z.string().optional().describe("Use for fiat payout"),
        externalWalletId: z.string().optional().describe("Use for crypto withdrawal"),
        amount: z.number().positive(),
        currency: z.string(),
        description: z.string().optional(),
        clientOrderId: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { createExternalTransfer } = await import("@/lib/fuze");
          return await createExternalTransfer(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_transfer: tool({
      description: "Get the status and details of a Fuze transfer by ID.",
      inputSchema: z.object({ transferId: z.string() }),
      execute: async ({ transferId }) => {
        try {
          const { getTransfer } = await import("@/lib/fuze");
          return await getTransfer(transferId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_transfers: tool({
      description: "List transfers for a Fuze user with optional pagination.",
      inputSchema: z.object({
        orgUserId: z.string(),
        page: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
      execute: async ({ orgUserId, page, limit }) => {
        try {
          const { listTransfers } = await import("@/lib/fuze");
          return await listTransfers(orgUserId, { page, limit });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_trade_quote: tool({
      description: "Get a time-locked exchange rate quote on Fuze. Supports crypto↔crypto, crypto↔fiat, and fiat↔fiat. Quote expires — use immediately.",
      inputSchema: z.object({
        customerId: z.string().describe("Fuze customer/orgUserId"),
        fromCurrency: z.string().describe("e.g. USDT, AED, USD"),
        fromAmount: z.number().positive(),
        toCurrency: z.string().describe("e.g. USDC, AED, INR"),
      }),
      execute: async ({ customerId, fromCurrency, fromAmount, toCurrency }) => {
        try {
          const { createTradeQuote } = await import("@/lib/fuze");
          return await createTradeQuote({ customerId, from: { currency: fromCurrency, amount: fromAmount }, to: { currency: toCurrency } });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_execute_trade_order: tool({
      description: "Execute a trade on Fuze using a previously obtained quoteId. Balances update instantly.",
      inputSchema: z.object({
        customerId: z.string(),
        quoteId: z.number().int().describe("quoteId from fuze_create_trade_quote"),
      }),
      execute: async (args) => {
        try {
          const { createTradeOrder } = await import("@/lib/fuze");
          return await createTradeOrder(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_remittance_originator: tool({
      description: "Create a remittance originator/sender on Fuze. Either email or phoneNumber is required.",
      inputSchema: z.object({
        name: z.string(),
        email: z.string().optional(),
        phoneNumber: z.string().optional(),
        address: z.string(),
        nationality: z.string().describe("ISO country code, e.g. GB"),
        country: z.string().describe("Sender country / ID issuing country, e.g. AE"),
        idType: z.string(),
        idNumber: z.string(),
        type: z.literal("ORIGINATOR").default("ORIGINATOR"),
        clientIdentifier: z.string(),
        dob: z.string().describe("YYYY-MM-DD"),
      }),
      execute: async (args) => {
        try {
          const { createRemittanceOriginator } = await import("@/lib/fuze");
          return await createRemittanceOriginator(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_fetch_remittance_originator: tool({
      description: "Fetch remittance originator/sender status by clientIdentifier.",
      inputSchema: z.object({ clientIdentifier: z.string() }),
      execute: async ({ clientIdentifier }) => {
        try {
          const { fetchRemittanceOriginator } = await import("@/lib/fuze");
          return await fetchRemittanceOriginator(clientIdentifier);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_remittance_beneficiary: tool({
      description: "Create a remittance beneficiary/receiver account under an originator.",
      inputSchema: z.object({
        thirdPartyClientIdentifier: z.string().describe("Originator clientIdentifier"),
        clientIdentifier: z.string().describe("Beneficiary clientIdentifier"),
        currency: z.string().describe("Local payout currency, e.g. INR"),
        accountType: z.string().describe("e.g. BANK, UPI"),
        country: z.string().describe("Beneficiary country, e.g. IN"),
        enableAccountVerification: z.boolean().optional(),
        accountData: z.record(z.string(), z.unknown()).describe("Country/payment-mode specific account fields"),
      }),
      execute: async (args) => {
        try {
          const { createRemittanceBeneficiary } = await import("@/lib/fuze");
          return await createRemittanceBeneficiary(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_fetch_remittance_beneficiary: tool({
      description: "Fetch remittance beneficiary/receiver status by clientIdentifier.",
      inputSchema: z.object({ clientIdentifier: z.string() }),
      execute: async ({ clientIdentifier }) => {
        try {
          const { fetchRemittanceBeneficiary } = await import("@/lib/fuze");
          return await fetchRemittanceBeneficiary(clientIdentifier);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_remittance_originator_with_beneficiary: tool({
      description: "Create a remittance originator and beneficiary account together in one Fuze call.",
      inputSchema: z.object({
        name: z.string(),
        email: z.string().optional(),
        phoneNumber: z.string().optional(),
        address: z.string(),
        nationality: z.string(),
        country: z.string(),
        idType: z.string(),
        idNumber: z.string(),
        type: z.literal("ORIGINATOR").default("ORIGINATOR"),
        clientIdentifier: z.string().describe("Originator clientIdentifier"),
        dob: z.string().describe("YYYY-MM-DD"),
        account: z.object({
          currency: z.string(),
          accountType: z.string(),
          country: z.string(),
          clientIdentifier: z.string().describe("Beneficiary clientIdentifier"),
          enableAccountVerification: z.boolean().optional(),
          accountData: z.record(z.string(), z.unknown()),
        }),
      }),
      execute: async (args) => {
        try {
          const { createRemittanceOriginatorWithBeneficiary } = await import("@/lib/fuze");
          return await createRemittanceOriginatorWithBeneficiary(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_remittance_quote: tool({
      description: "Get a cross-border remittance rate quote on Fuze (e.g. USDT → INR). Rate expires — confirm before executing.",
      inputSchema: z.object({
        fromCurrency: z.string().describe("e.g. USDT, AED"),
        toCurrency: z.string().describe("e.g. INR, USD"),
        quantity: z.number().positive(),
        orgUserId: z.string(),
      }),
      execute: async (args) => {
        try {
          const { createRemittanceQuote } = await import("@/lib/fuze");
          return await createRemittanceQuote(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_remittance_payment: tool({
      description: "Execute a remittance payment on Fuze using a locked quoteId.",
      inputSchema: z.object({
        quoteId: z.number().int(),
        quantity: z.number().positive(),
        orgUserId: z.string(),
      }),
      execute: async (args) => {
        try {
          const { executeRemittancePayment } = await import("@/lib/fuze");
          return await executeRemittancePayment(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_fetch_remittance_payment: tool({
      description: "Fetch the status of a Fuze remittance payment by its UUID.",
      inputSchema: z.object({ uuid: z.string() }),
      execute: async ({ uuid }) => {
        try {
          const { fetchRemittancePayment } = await import("@/lib/fuze");
          return await fetchRemittancePayment(uuid);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_remittance_balance: tool({
      description: "Get the organization's current remittance balance across all currencies on Fuze.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { getRemittanceBalance } = await import("@/lib/fuze");
          return await getRemittanceBalance();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_verify_beneficiary: tool({
      description: "Verify a payout beneficiary's bank account or UPI ID before sending a remittance payout.",
      inputSchema: z.object({
        receiverClientIdentifier: z.string(),
        currency: z.string(),
        accountType: z.string().describe("e.g. BANK, UPI"),
        country: z.string(),
        accountNumber: z.string().optional(),
        ifscCode: z.string().optional(),
        upiId: z.string().optional(),
        name: z.string(),
        bankAccountType: z.string().optional(),
      }),
      execute: async ({ receiverClientIdentifier, currency, accountType, country, accountNumber, ifscCode, upiId, name, bankAccountType }) => {
        try {
          const { verifyBeneficiary } = await import("@/lib/fuze");
          return await verifyBeneficiary({
            receiverClientIdentifier, currency, accountType, country,
            accountData: { accountNumber, ifscCode, upiId, name, bankAccountType },
          });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_remittance_payout: tool({
      description: "Send a full remittance payout on Fuze with sender and beneficiary details. Supports bank transfer and UPI.",
      inputSchema: z.object({
        senderEmail: z.string(),
        senderName: z.string(),
        senderAddress: z.string(),
        senderNationality: z.string(),
        senderIdType: z.string().describe("e.g. PASSPORT, NATIONAL_ID"),
        senderIdNumber: z.string(),
        senderClientIdentifier: z.string(),
        senderCountry: z.string(),
        senderDob: z.string().describe("YYYY-MM-DD"),
        clientOrderId: z.string().describe("Unique idempotency key"),
        amount: z.number().positive(),
        purpose: z.string().describe("e.g. family_support, trade_finance"),
        receiverClientIdentifier: z.string(),
        receiverCurrency: z.string().describe("e.g. INR"),
        accountType: z.string().describe("e.g. BANK, UPI"),
        receiverCountry: z.string(),
        accountNumber: z.string().optional(),
        ifscCode: z.string().optional(),
        upiId: z.string().optional(),
        beneficiaryName: z.string(),
      }),
      execute: async (args) => {
        try {
          const { createRemittancePayout } = await import("@/lib/fuze");
          return await createRemittancePayout({
            email: args.senderEmail,
            name: args.senderName,
            address: args.senderAddress,
            nationality: args.senderNationality,
            idType: args.senderIdType,
            idNumber: args.senderIdNumber,
            senderClientIdentifier: args.senderClientIdentifier,
            country: args.senderCountry,
            dob: args.senderDob,
            clientOrderId: args.clientOrderId,
            amount: args.amount,
            purpose: args.purpose,
            account: {
              receiverClientIdentifier: args.receiverClientIdentifier,
              currency: args.receiverCurrency,
              accountType: args.accountType,
              country: args.receiverCountry,
              accountData: {
                accountNumber: args.accountNumber,
                ifscCode: args.ifscCode,
                upiId: args.upiId,
                name: args.beneficiaryName,
              },
            },
          });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_remittance_payout_to_beneficiary: tool({
      description: "Transfer local-currency remittance funds to an already-created beneficiary. Use after the originator/beneficiary are verified and local currency has been bought.",
      inputSchema: z.object({
        currency: z.string().describe("Local payout currency, e.g. INR"),
        amount: z.number().positive(),
        clientOrderId: z.string().describe("Unique idempotency key"),
        clientIdentifier: z.string().describe("Beneficiary clientIdentifier"),
        purpose: z.string().describe("Purpose code, e.g. SALARY, FAMILY"),
        extra: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ extra, ...args }) => {
        try {
          const { createRemittancePayoutToBeneficiary } = await import("@/lib/fuze");
          return await createRemittancePayoutToBeneficiary({ ...args, ...(extra ?? {}) });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_remittance_payouts: tool({
      description: "List remittance payout status records for a beneficiary clientIdentifier.",
      inputSchema: z.object({ clientIdentifier: z.string() }),
      execute: async ({ clientIdentifier }) => {
        try {
          const { listRemittancePayouts } = await import("@/lib/fuze");
          return await listRemittancePayouts(clientIdentifier);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_fetch_payout_status: tool({
      description: "Check the status of a Fuze remittance payout by clientOrderId.",
      inputSchema: z.object({ clientOrderId: z.string() }),
      execute: async ({ clientOrderId }) => {
        try {
          const { fetchRemittancePayout } = await import("@/lib/fuze");
          return await fetchRemittancePayout(clientOrderId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_kyc_upload_link: tool({
      description: "Get a presigned upload URL for a KYC document for a Fuze user. Use for API-driven onboarding when uploading passports, IDs, proof of address, etc.",
      inputSchema: z.object({
        orgUserId: z.string(),
        docCategory: z.string().describe("e.g. PASSPORT, NATIONAL_ID, ADDRESS, SOURCE_OF_FUNDS, INCORPORATION_CERTIFICATE"),
      }),
      execute: async (args) => {
        try {
          const { getKycFileUploadLink } = await import("@/lib/fuze");
          return await getKycFileUploadLink(args.orgUserId, args.docCategory);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_update_edd: tool({
      description: "Mark enhanced due diligence (EDD) as complete for a high-risk Fuze user.",
      inputSchema: z.object({
        orgUserId: z.string(),
        eddCompleted: z.boolean(),
      }),
      execute: async (args) => {
        try {
          const { updateEddTracker } = await import("@/lib/fuze");
          return await updateEddTracker(args.orgUserId, args.eddCompleted);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_assets: tool({
      description: "List all tradeable assets on Fuze with metadata — name, symbol, icon, market cap, 24h price change.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listAssets } = await import("@/lib/fuze");
          return await listAssets();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_current_price: tool({
      description: "Get the current spot price for a trading pair on Fuze (e.g. BTC_USD, ETH_AED).",
      inputSchema: z.object({ symbol: z.string().describe("Trading pair symbol, e.g. BTC_USD") }),
      execute: async ({ symbol }) => {
        try {
          const { getCurrentPrice } = await import("@/lib/fuze");
          return await getCurrentPrice(symbol);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_candle_price: tool({
      description: "Get OHLCV candle data for a Fuze trading pair — useful for charting buy/sell price history.",
      inputSchema: z.object({
        symbol: z.string().describe("Trading pair symbol, e.g. BTC_USD"),
        interval: z.string().optional().describe("Candle interval, e.g. 1h, 1d"),
      }),
      execute: async ({ symbol, interval }) => {
        try {
          const { getCandlePrice } = await import("@/lib/fuze");
          return await getCandlePrice(symbol, interval);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_historical_prices: tool({
      description: "Get historical price data for a Fuze asset over a time range.",
      inputSchema: z.object({
        symbol: z.string(),
        from: z.number().optional().describe("Start timestamp (Unix seconds)"),
        to: z.number().optional().describe("End timestamp (Unix seconds)"),
      }),
      execute: async ({ symbol, from, to }) => {
        try {
          const { getHistoricalPrices } = await import("@/lib/fuze");
          return await getHistoricalPrices(symbol, from, to);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_news: tool({
      description: "Get crypto news articles from Fuze — useful for market context when users ask about price movements.",
      inputSchema: z.object({
        limit: z.number().int().optional().describe("Number of articles to return"),
      }),
      execute: async ({ limit }) => {
        try {
          const { getNews } = await import("@/lib/fuze");
          return await getNews(limit);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_trade_order: tool({
      description: "Get the status and details of a specific Fuze trade order by orderId.",
      inputSchema: z.object({ orderId: z.number().int() }),
      execute: async ({ orderId }) => {
        try {
          const { getTradeOrder } = await import("@/lib/fuze");
          return await getTradeOrder(orderId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_trade_orders: tool({
      description: "List all trade orders for a Fuze user — full transaction history.",
      inputSchema: z.object({
        orgUserId: z.string(),
        page: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
      execute: async ({ orgUserId, page, limit }) => {
        try {
          const { listTradeOrders } = await import("@/lib/fuze");
          return await listTradeOrders(orgUserId, { page, limit });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_user_pnl: tool({
      description: "Get the profit & loss summary for a Fuze user — total, realized, and unrealized P&L.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { getUserPnl } = await import("@/lib/fuze");
          return await getUserPnl(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_watchlist: tool({
      description: "Get a Fuze user's asset watchlist with current prices and 24h changes.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { getWatchlist } = await import("@/lib/fuze");
          return await getWatchlist(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_upsert_kyc: tool({
      description: "Submit or update KYC details for a Fuze user via the API-driven hybrid flow (name, DOB, address, ID number, nationality, etc.).",
      inputSchema: z.object({
        orgUserId: z.string(),
        kycData: z.record(z.string(), z.unknown()).describe("KYC fields: firstName, lastName, dob, nationality, idType, idNumber, address, etc."),
      }),
      execute: async ({ orgUserId, kycData }) => {
        try {
          const { upsertUserKyc } = await import("@/lib/fuze");
          return await upsertUserKyc(orgUserId, kycData);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_countries: tool({
      description: "List all countries supported by Fuze for onboarding and payouts.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listCountries } = await import("@/lib/fuze");
          return await listCountries();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_account_currencies: tool({
      description: "List all fiat currencies supported by Fuze for internal accounts (AED, USD, EUR, GBP, etc.).",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listAccountCurrencies } = await import("@/lib/fuze");
          return await listAccountCurrencies();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_wallet_currencies: tool({
      description: "List all crypto assets/networks supported by Fuze for internal wallets.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listWalletCurrencies } = await import("@/lib/fuze");
          return await listWalletCurrencies();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_vasps: tool({
      description: "List Virtual Asset Service Providers (VASPs) registered on Fuze — used for Travel Rule compliance on crypto transfers.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listVasps } = await import("@/lib/fuze");
          return await listVasps();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_screen_external_wallet: tool({
      description: "Run Chainalysis sanctions screening on an external wallet address before registering it or sending funds to it.",
      inputSchema: z.object({
        address: z.string().describe("Crypto wallet address to screen"),
        currency: z.string().describe("e.g. USDT, BTC"),
        network: z.string().describe("e.g. ethereum, tron"),
      }),
      execute: async (args) => {
        try {
          const { screenExternalWallet } = await import("@/lib/fuze");
          return await screenExternalWallet(args.address, args.currency, args.network);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_wallets_unified: tool({
      description: "List wallets for a Fuze user using the unified endpoint. Filter by INTERNAL (Fuze-hosted) or EXTERNAL (withdrawal destinations).",
      inputSchema: z.object({
        orgUserId: z.string(),
        walletType: z.enum(["INTERNAL", "EXTERNAL"]).optional(),
      }),
      execute: async ({ orgUserId, walletType }) => {
        try {
          const { listWallets } = await import("@/lib/fuze");
          return await listWallets(orgUserId, walletType);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_wallet_by_id: tool({
      description: "Get a specific Fuze wallet (internal or external) by its walletId.",
      inputSchema: z.object({ walletId: z.string() }),
      execute: async ({ walletId }) => {
        try {
          const { getWalletById } = await import("@/lib/fuze");
          return await getWalletById(walletId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_accounts_unified: tool({
      description: "List all fiat accounts for a Fuze user using the unified accounts endpoint.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { listAccountsUnified } = await import("@/lib/fuze");
          return await listAccountsUnified(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_account_by_id: tool({
      description: "Get a specific Fuze fiat account by accountId.",
      inputSchema: z.object({ accountId: z.string() }),
      execute: async ({ accountId }) => {
        try {
          const { getAccountById } = await import("@/lib/fuze");
          return await getAccountById(accountId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_delete_counterparty: tool({
      description: "Soft-delete a Fuze counterparty. This removes their linked wallets and accounts from active use.",
      inputSchema: z.object({ counterpartyId: z.string() }),
      execute: async ({ counterpartyId }) => {
        try {
          const { deleteCounterparty } = await import("@/lib/fuze");
          return await deleteCounterparty(counterpartyId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_cancel_order: tool({
      description: "Cancel an open Fuze trade order that has not yet been filled.",
      inputSchema: z.object({
        orderId: z.number().int(),
        orgUserId: z.string(),
      }),
      execute: async (args) => {
        try {
          const { cancelOrder } = await import("@/lib/fuze");
          return await cancelOrder(args.orderId, args.orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_update_external_transfer: tool({
      description: "Update a Fuze external transfer that is still in CREATED state (before confirmation).",
      inputSchema: z.object({
        transferId: z.string(),
        updates: z.record(z.string(), z.unknown()).describe("Fields to update on the transfer"),
      }),
      execute: async ({ transferId, updates }) => {
        try {
          const { updateExternalTransfer } = await import("@/lib/fuze");
          return await updateExternalTransfer(transferId, updates);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_confirm_external_transfer: tool({
      description: "Confirm and execute a Fuze external transfer that is in CREATED state.",
      inputSchema: z.object({ transferId: z.string() }),
      execute: async ({ transferId }) => {
        try {
          const { confirmExternalTransfer } = await import("@/lib/fuze");
          return await confirmExternalTransfer(transferId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_reversal: tool({
      description: "Create a reversal transaction to refund a rejected or failed inbound Fuze deposit back to the sender.",
      inputSchema: z.object({
        transferId: z.string(),
        reason: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { createReversalTransaction } = await import("@/lib/fuze");
          return await createReversalTransaction(args.transferId, args.reason);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_transfer_upload_link: tool({
      description: "Get a presigned upload URL for supporting documents required for a Fuze transfer (e.g. invoice, purpose declaration).",
      inputSchema: z.object({
        transferId: z.string(),
        docType: z.string().describe("Document type required for this transfer"),
      }),
      execute: async (args) => {
        try {
          const { getTransferUploadLink } = await import("@/lib/fuze");
          return await getTransferUploadLink(args.transferId, args.docType);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_transfer_currencies: tool({
      description: "List all currencies supported for Fuze transfers — fiat and crypto.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listTransferCurrencies } = await import("@/lib/fuze");
          return await listTransferCurrencies();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_required_transfer_files: tool({
      description: "List the documents required for a Fuze transfer given its purpose and currency (e.g. invoice for trade finance).",
      inputSchema: z.object({
        purpose: z.string().describe("Transfer purpose, e.g. trade_finance, family_support"),
        currency: z.string(),
      }),
      execute: async (args) => {
        try {
          const { listRequiredTransferFiles } = await import("@/lib/fuze");
          return await listRequiredTransferFiles(args.purpose, args.currency);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_upsert_webhook: tool({
      description: "Create or update the Fuze webhook endpoint — set the URL and signing secret for receiving event notifications.",
      inputSchema: z.object({
        url: z.string().describe("Webhook URL to receive Fuze events"),
        secret: z.string().describe("Secret key for HMAC-SHA256 signature verification"),
      }),
      execute: async (args) => {
        try {
          const { upsertWebhook } = await import("@/lib/fuze");
          return await upsertWebhook(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_webhook: tool({
      description: "Get the current Fuze webhook configuration — URL and active status.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { getWebhook } = await import("@/lib/fuze");
          return await getWebhook();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_simulate_webhook: tool({
      description: "Trigger a test Fuze webhook event in pre-production — useful for testing event handling without real transactions.",
      inputSchema: z.object({
        entity: z.string().describe("Entity type, e.g. Users, Orders, Transfers"),
        eventType: z.string().describe("Event type, e.g. UPDATE, KYC_COMPLETED"),
      }),
      execute: async (args) => {
        try {
          const { simulateWebhook } = await import("@/lib/fuze");
          return await simulateWebhook(args.entity, args.eventType);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_create_watchlist: tool({
      description: "Create a new asset watchlist for a Fuze user.",
      inputSchema: z.object({
        orgUserId: z.string(),
        symbols: z.array(z.string()).describe("Array of asset symbols, e.g. ['BTC_USD', 'ETH_AED']"),
      }),
      execute: async (args) => {
        try {
          const { createWatchlist } = await import("@/lib/fuze");
          return await createWatchlist(args.orgUserId, args.symbols);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_update_watchlist: tool({
      description: "Update a Fuze user's watchlist — replace the symbols in an existing watchlist.",
      inputSchema: z.object({
        orgUserId: z.string(),
        watchlistId: z.string(),
        symbols: z.array(z.string()),
      }),
      execute: async (args) => {
        try {
          const { updateWatchlist } = await import("@/lib/fuze");
          return await updateWatchlist(args.orgUserId, args.watchlistId, args.symbols);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_delete_watchlist: tool({
      description: "Delete a Fuze user's watchlist.",
      inputSchema: z.object({
        orgUserId: z.string(),
        watchlistId: z.string(),
      }),
      execute: async (args) => {
        try {
          const { deleteWatchlist } = await import("@/lib/fuze");
          return await deleteWatchlist(args.orgUserId, args.watchlistId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_fee_estimate: tool({
      description: "Get a fee estimate for a Fuze transfer or withdrawal by currency and network.",
      inputSchema: z.object({
        currency: z.string(),
        network: z.string().optional(),
        transferType: z.string().optional().describe("e.g. INTERNAL, EXTERNAL"),
      }),
      execute: async (args) => {
        try {
          const { getFeeEstimate } = await import("@/lib/fuze");
          return await getFeeEstimate(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_get_settlement_orders: tool({
      description: "Get orders pending settlement on Fuze — used for OTC desk and batch settlement workflows.",
      inputSchema: z.object({
        page: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { getSettlementOrders } = await import("@/lib/fuze");
          return await getSettlementOrders(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_list_settlements: tool({
      description: "List completed settlements for your Fuze organization.",
      inputSchema: z.object({
        page: z.number().int().optional(),
        limit: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { listSettlements } = await import("@/lib/fuze");
          return await listSettlements(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_delete_user: tool({
      description: "Delete (offboard) a Fuze user account. This is permanent — sets userStatus to DELETED.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { deleteUser } = await import("@/lib/fuze");
          return await deleteUser(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_accept_tnc: tool({
      description: "Accept Fuze Terms & Conditions for a user. Required alongside KYC approval before a user becomes ACTIVE and can transact.",
      inputSchema: z.object({ orgUserId: z.string() }),
      execute: async ({ orgUserId }) => {
        try {
          const { acceptTermsAndConditions } = await import("@/lib/fuze");
          return await acceptTermsAndConditions(orgUserId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_create_customer: tool({
      description: "Create or update a Fuze Pay gateway customer/counterparty for payment gateway payins, payouts, and deposit wallets.",
      inputSchema: z.object({
        clientIdentifier: z.string().describe("Unique non-PII customer identifier"),
        email: z.string().optional(),
        type: z.literal("THIRD_PARTY").default("THIRD_PARTY"),
        kycData: z.record(z.string(), z.unknown()).describe("Fuze Pay third-party KYC fields from the payments API docs"),
        sumsubToken: z.string().optional(),
        extra: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ extra, ...args }) => {
        try {
          const { createGatewayCustomer } = await import("@/lib/fuze");
          return await createGatewayCustomer({ ...args, ...(extra ?? {}) });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_update_customer_kyc: tool({
      description: "Update an existing Fuze Pay gateway customer's KYC data.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        kycData: z.record(z.string(), z.unknown()).describe("Updated Fuze Pay KYC fields"),
      }),
      execute: async (args) => {
        try {
          const { updateGatewayCustomerKyc } = await import("@/lib/fuze");
          return await updateGatewayCustomerKyc(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_get_kyc_file_upload_link: tool({
      description: "Generate a presigned upload URL for a Fuze Pay customer KYC document.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        fileName: z.string(),
        docCategory: z.string().describe("e.g. IDENTITY_FRONT, ADDRESS, SOURCE_OF_FUNDS"),
        docSubCategory: z.string().optional().describe("e.g. PASSPORT, NATIONAL_ID"),
        docdescription: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { getGatewayKycFileUploadLink } = await import("@/lib/fuze");
          return await getGatewayKycFileUploadLink(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_fetch_customer: tool({
      description: "Fetch a Fuze Pay gateway customer by clientIdentifier.",
      inputSchema: z.object({ clientIdentifier: z.string() }),
      execute: async ({ clientIdentifier }) => {
        try {
          const { fetchGatewayCustomer } = await import("@/lib/fuze");
          return await fetchGatewayCustomer(clientIdentifier);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_list_customers: tool({
      description: "List/search Fuze Pay gateway customers.",
      inputSchema: z.object({
        query: z.string().optional(),
        status: z.string().optional(),
        pageSize: z.number().int().optional(),
        pageNumber: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { listGatewayCustomers } = await import("@/lib/fuze");
          return await listGatewayCustomers(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_list_supported_assets: tool({
      description: "List Fuze Pay supported crypto assets with their supported chains and test/main networks.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { listGatewaySupportedAssets } = await import("@/lib/fuze");
          return await listGatewaySupportedAssets();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_get_conversion_rate: tool({
      description: "Get a Fuze Pay crypto/fiat conversion rate for BUY or SELL before creating a payin or payout.",
      inputSchema: z.object({
        symbol: z.string().describe("e.g. USDC_USD"),
        operation: z.enum(["BUY", "SELL"]),
        quantity: z.number().positive().optional(),
        quoteQuantity: z.number().positive().optional(),
      }),
      execute: async (args) => {
        try {
          const { getGatewayConversionRate } = await import("@/lib/fuze");
          return await getGatewayConversionRate(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_create_deposit_wallet: tool({
      description: "Create or fetch a reusable Fuze Pay deposit wallet. Use symbols like USDC for crypto settlement or USDC_USD for automatic conversion.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        symbol: z.string().describe("e.g. USDC, USDC_USD"),
        chain: z.string().describe("e.g. POLYGON"),
      }),
      execute: async (args) => {
        try {
          const { createGatewayDepositWallet } = await import("@/lib/fuze");
          return await createGatewayDepositWallet(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_fetch_deposit_wallet: tool({
      description: "Fetch a Fuze Pay deposit wallet for a customer, symbol, and chain.",
      inputSchema: z.object({ clientIdentifier: z.string(), symbol: z.string(), chain: z.string() }),
      execute: async (args) => {
        try {
          const { fetchGatewayDepositWallet } = await import("@/lib/fuze");
          return await fetchGatewayDepositWallet(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_list_deposit_wallets: tool({
      description: "List Fuze Pay deposit wallets, optionally filtered by customer, symbol, chain, or status.",
      inputSchema: z.object({
        clientIdentifier: z.string().optional(),
        symbol: z.string().optional(),
        chain: z.string().optional(),
        status: z.string().optional(),
        pageSize: z.number().int().optional(),
        pageNumber: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { listGatewayDepositWallets } = await import("@/lib/fuze");
          return await listGatewayDepositWallets(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_create_payin_quote: tool({
      description: "Create a Fuze Pay payin/conversion quote before requesting a customer payment.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        symbol: z.string(),
        chain: z.string().optional(),
        quantity: z.number().positive().optional(),
        quoteQuantity: z.number().positive().optional(),
      }),
      execute: async (args) => {
        try {
          const { createGatewayPayinQuote } = await import("@/lib/fuze");
          return await createGatewayPayinQuote(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_create_payin: tool({
      description: "Create a Fuze Pay payin. Confirm amount, symbol, chain, and expiry with the user before creating it.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        symbol: z.string(),
        chain: z.string().optional(),
        quantity: z.number().positive().optional(),
        quoteQuantity: z.number().positive().optional(),
        quoteId: z.number().int().optional(),
        clientOrderId: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { createGatewayPayin } = await import("@/lib/fuze");
          return await createGatewayPayin(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_fetch_payin: tool({
      description: "Fetch the status of a Fuze Pay payin by clientOrderId.",
      inputSchema: z.object({ clientOrderId: z.string() }),
      execute: async ({ clientOrderId }) => {
        try {
          const { fetchGatewayPayin } = await import("@/lib/fuze");
          return await fetchGatewayPayin(clientOrderId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_list_payins: tool({
      description: "List Fuze Pay payins with optional customer, date, status, and pagination filters.",
      inputSchema: z.object({
        clientIdentifier: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        status: z.string().optional(),
        pageSize: z.number().int().optional(),
        pageNumber: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { listGatewayPayins } = await import("@/lib/fuze");
          return await listGatewayPayins(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_create_payout_quote: tool({
      description: "Create a Fuze Pay payout quote before sending funds to an external wallet.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        symbol: z.string(),
        chain: z.string(),
        address: z.string().optional(),
        quantity: z.number().positive().optional(),
        quoteQuantity: z.number().positive().optional(),
      }),
      execute: async (args) => {
        try {
          const { createGatewayPayoutQuote } = await import("@/lib/fuze");
          return await createGatewayPayoutQuote(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_create_payout: tool({
      description: "Create a Fuze Pay payout to a wallet. Must only be used after explicit user confirmation.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        address: z.string(),
        chain: z.string(),
        symbol: z.string(),
        quantity: z.number().positive().optional(),
        quoteQuantity: z.number().positive().optional(),
        quoteId: z.number().int().optional(),
        clientOrderId: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { createGatewayPayout } = await import("@/lib/fuze");
          return await createGatewayPayout(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_create_refund: tool({
      description: "Create a Fuze Pay refund for a completed or rejected payin using the parent payin clientOrderId. Must only be used after explicit user confirmation.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        address: z.string(),
        chain: z.string(),
        symbol: z.string(),
        parentClientOrderId: z.string(),
        quantity: z.number().positive().optional(),
        quoteId: z.number().int().optional(),
        clientOrderId: z.string().optional(),
      }),
      execute: async (args) => {
        try {
          const { createGatewayRefund } = await import("@/lib/fuze");
          return await createGatewayRefund(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_fetch_payout: tool({
      description: "Fetch the status of a Fuze Pay payout or refund by clientOrderId.",
      inputSchema: z.object({ clientOrderId: z.string() }),
      execute: async ({ clientOrderId }) => {
        try {
          const { fetchGatewayPayout } = await import("@/lib/fuze");
          return await fetchGatewayPayout(clientOrderId);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_list_payouts: tool({
      description: "List Fuze Pay payouts/refunds with optional customer, date, status, and pagination filters.",
      inputSchema: z.object({
        clientIdentifier: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        status: z.string().optional(),
        pageSize: z.number().int().optional(),
        pageNumber: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { listGatewayPayouts } = await import("@/lib/fuze");
          return await listGatewayPayouts(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_whitelist_wallet: tool({
      description: "Whitelist or unblock a source wallet for Fuze Pay Travel Rule/AML review when a payin webhook reports TRAVELRULE_PENDING.",
      inputSchema: z.object({
        clientIdentifier: z.string(),
        address: z.string(),
        asset: z.string().describe("Crypto asset, e.g. USDT or USDC"),
        chain: z.string(),
        walletType: z.enum(["DECENTRALIZED", "CUSTODIAL"]).default("DECENTRALIZED"),
        memo: z.string().optional(),
        nickname: z.string().optional(),
        vaspDid: z.string().optional(),
        vaspName: z.string().optional(),
        vaspWebsite: z.string().optional(),
        ownershipProof: z.record(z.string(), z.unknown()).default({
          beneficiaryProof: { type: "checkbox_confirmation", proof: "checked" },
        }),
        extra: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ extra, ...args }) => {
        try {
          const { whitelistGatewayWallet } = await import("@/lib/fuze");
          return await whitelistGatewayWallet({ ...args, ...(extra ?? {}) });
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_get_account_balances: tool({
      description: "Get Fuze Pay merchant account fiat balances for all supported currencies.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { getGatewayAccountBalances } = await import("@/lib/fuze");
          return await getGatewayAccountBalances();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_gateway_list_account_transactions: tool({
      description: "List Fuze Pay merchant account transactions such as fiat deposits and withdrawals.",
      inputSchema: z.object({
        currency: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        pageSize: z.number().int().optional(),
        pageNumber: z.number().int().optional(),
      }),
      execute: async (args) => {
        try {
          const { listGatewayAccountTransactions } = await import("@/lib/fuze");
          return await listGatewayAccountTransactions(args);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    fuze_banking_directory: tool({
      description: "Get the banking and wallet directory for a country — lists available banks, routing codes, and wallet providers for Fuze payouts.",
      inputSchema: z.object({ country: z.string().describe("ISO 3166-1 alpha-2 country code, e.g. IN, AE, US") }),
      execute: async ({ country }) => {
        try {
          const { getBankingDirectory } = await import("@/lib/fuze");
          return await getBankingDirectory(country);
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── xStocks ───────────────────────────────────────────────────────────────

    xstocks_list_assets: tool({
      description: "List all tokenized stocks available on xStocks — call this when the user asks 'what stocks are on xStocks?', 'show me xStocks assets', or wants to browse available tokenized stocks. Returns names, symbols, chains, contract addresses.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { listAssets } = await import("@/lib/xstocks"); return await listAssets(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_asset: tool({
      description: "Get full details for a single xStocks tokenized stock — call this when the user asks about a specific stock like 'tell me about AAPL on xStocks', 'show me TSLA details', or needs contract addresses, chains, or metadata for a symbol.",
      inputSchema: z.object({ symbol: z.string().describe("Stock ticker symbol, e.g. AAPL, TSLA, NVDA, MSFT, GOOGL") }),
      execute: async ({ symbol }) => {
        try { const { getAsset } = await import("@/lib/xstocks"); return await getAsset(symbol); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_asset_price_data: tool({
      description: "Get OHLCV price history for a tokenized stock on xStocks — call this when the user asks 'what's the AAPL price on xStocks?', 'show me TSLA price history', or 'how has NVDA performed?'. Use interval '1d' for daily, '1h' for hourly. Omit from/to for recent data.",
      inputSchema: z.object({
        symbol: z.string().describe("Stock ticker symbol, e.g. AAPL"),
        from: z.string().optional().describe("Start date ISO 8601, e.g. 2024-01-01"),
        to: z.string().optional().describe("End date ISO 8601, e.g. 2024-12-31"),
        interval: z.string().optional().describe("Candle interval: 1d (daily), 1h (hourly), 5m (5-min)"),
      }),
      execute: async ({ symbol, from, to, interval }) => {
        try { const { getAssetPriceData } = await import("@/lib/xstocks"); return await getAssetPriceData(symbol, { from, to, interval }); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_asset_multiplier: tool({
      description: "Get the current stock-split multiplier for an xStocks token — call this when user asks about the current split ratio or token denomination for a stock. A multiplier of 2 means the token represents 2 original shares (post-split).",
      inputSchema: z.object({ symbol: z.string().describe("Stock ticker symbol") }),
      execute: async ({ symbol }) => {
        try { const { getAssetMultiplier } = await import("@/lib/xstocks"); return await getAssetMultiplier(symbol); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_multiplier_history: tool({
      description: "Get the full history of stock-split multiplier changes for an xStocks token — use this when user asks about past splits or reverse-splits for a stock.",
      inputSchema: z.object({
        symbol: z.string(),
        from: z.string().optional().describe("ISO 8601 start date"),
        to: z.string().optional().describe("ISO 8601 end date"),
        limit: z.number().optional(),
      }),
      execute: async ({ symbol, from, to, limit }) => {
        try { const { getAssetMultiplierHistory } = await import("@/lib/xstocks"); return await getAssetMultiplierHistory(symbol, { from, to, limit }); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_circulating_supply: tool({
      description: "Get the current number of tokens in circulation for an xStocks stock — use when user asks 'how many AAPL tokens are out there?' or wants to assess liquidity.",
      inputSchema: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        try { const { getAssetCirculatingSupply } = await import("@/lib/xstocks"); return await getAssetCirculatingSupply(symbol); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_total_supply: tool({
      description: "Get the total number of tokens ever minted for an xStocks stock (includes redeemed tokens) — use alongside circulating supply to understand redemption activity.",
      inputSchema: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        try { const { getAssetTotalSupply } = await import("@/lib/xstocks"); return await getAssetTotalSupply(symbol); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_list_proof_of_reserves: tool({
      description: "List reserve attestation reports for all xStocks tokenized stocks — call this when user asks 'is xStocks legit?', 'how are tokens backed?', 'show me proof of reserves', or 'are the shares really held?'. Returns custodian attestation data.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { listProofOfReserves } = await import("@/lib/xstocks"); return await listProofOfReserves(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_proof_of_reserves: tool({
      description: "Get the reserve attestation report for a specific tokenized stock — call this when user wants proof of backing for a particular stock like 'show me AAPL reserve proof'.",
      inputSchema: z.object({ symbol: z.string().describe("Stock ticker symbol") }),
      execute: async ({ symbol }) => {
        try { const { getProofOfReserves } = await import("@/lib/xstocks"); return await getProofOfReserves(symbol); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_list_oracles: tool({
      description: "List all on-chain price oracle contract addresses across networks for xStocks tokens — call when user asks about price feeds, oracle addresses, or which chains have price data.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { listOracles } = await import("@/lib/xstocks"); return await listOracles(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_oracle: tool({
      description: "Get the on-chain price oracle contract address for a specific xStocks stock — use when user asks for the oracle address of a particular token for on-chain integration.",
      inputSchema: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        try { const { getOracle } = await import("@/lib/xstocks"); return await getOracle(symbol); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_system_status: tool({
      description: "Get the current operational status (minting enabled / redemption enabled / halted) for an xStocks tokenized stock — call this when user asks 'can I mint AAPL tokens?', 'is TSLA redemption open?', or before starting a primary market trade.",
      inputSchema: z.object({ symbol: z.string().describe("Stock ticker symbol") }),
      execute: async ({ symbol }) => {
        try { const { getSystemStatus } = await import("@/lib/xstocks"); return await getSystemStatus(symbol); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_system_wallets: tool({
      description: "Get the public treasury and fee wallet addresses used by xStocks — call when user asks for official xStocks wallet addresses or wants to verify a wallet they received.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getSystemWallets } = await import("@/lib/xstocks"); return await getSystemWallets(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_corporate_actions_history: tool({
      description: "Get past corporate actions for xStocks tokens — call when user asks about historical stock splits, reverse splits, mergers, dividends, or spin-offs. Optionally filter by symbol and date range.",
      inputSchema: z.object({
        symbol: z.string().optional().describe("Filter by stock symbol, e.g. AAPL — omit to get all"),
        from: z.string().optional().describe("ISO 8601 start date"),
        to: z.string().optional().describe("ISO 8601 end date"),
      }),
      execute: async ({ symbol, from, to }) => {
        try { const { getCorporateActionsHistory } = await import("@/lib/xstocks"); return await getCorporateActionsHistory({ symbol, from, to }); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_corporate_actions_upcoming: tool({
      description: "Get upcoming scheduled corporate actions for xStocks tokens — call when user asks 'any upcoming splits?', 'what corporate events are coming?', or wants to plan ahead around a specific stock.",
      inputSchema: z.object({
        symbol: z.string().optional().describe("Filter by stock symbol — omit to get all upcoming events"),
      }),
      execute: async ({ symbol }) => {
        try { const { getCorporateActionsUpcoming } = await import("@/lib/xstocks"); return await getCorporateActionsUpcoming({ symbol }); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_list_public_bridges: tool({
      description: "List supported cross-chain bridge routes for xStocks tokens (no API key needed) — call when user asks which chains they can bridge tokens between or how to move tokens cross-chain.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { listPublicBridges } = await import("@/lib/xstocks"); return await listPublicBridges(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_registered_wallets: tool({
      description: "List wallets that are whitelisted for the xStocks API account — call when user asks 'what wallets do I have on xStocks?', 'show my registered wallets', or before initiating a trade to check if the wallet is approved.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getRegisteredWallets } = await import("@/lib/xstocks"); return await getRegisteredWallets(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_client_limits: tool({
      description: "Get trading and wallet limits for the xStocks account — call when user asks 'what are my limits?', 'how much can I trade?', or 'what's my max position size on xStocks?'.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getClientLimits } = await import("@/lib/xstocks"); return await getClientLimits(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_client_usage: tool({
      description: "Get current usage vs limits for the xStocks account — call alongside xstocks_get_client_limits when user asks how much of their limit they've used, or before a large trade to check headroom.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getClientUsage } = await import("@/lib/xstocks"); return await getClientUsage(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_whitelist_challenge: tool({
      description: "Step 1 of wallet whitelisting: request a signing challenge for a new wallet address. Call this when user wants to add a wallet to xStocks. Returns a challenge string the user must sign with their wallet. Then call xstocks_submit_whitelist with the signature.",
      inputSchema: z.object({
        walletAddress: z.string().describe("Wallet address to whitelist, e.g. 0x..."),
        chain: z.string().describe("Blockchain name, e.g. ethereum, polygon, arbitrum"),
      }),
      execute: async ({ walletAddress, chain }) => {
        try { const { createWhitelistChallenge } = await import("@/lib/xstocks"); return await createWhitelistChallenge({ walletAddress, chain }); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_submit_whitelist: tool({
      description: "Step 2 of wallet whitelisting: submit the signed challenge to complete whitelisting. Call this after the user has signed the challenge from xstocks_whitelist_challenge. The wallet is approved once this succeeds.",
      inputSchema: z.object({
        walletAddress: z.string().describe("Same wallet address from the challenge step"),
        chain: z.string().describe("Same chain from the challenge step"),
        challenge: z.string().describe("The challenge string returned by xstocks_whitelist_challenge"),
        signature: z.string().describe("The hex signature the user signed with their wallet"),
      }),
      execute: async ({ walletAddress, chain, signature, challenge }) => {
        try { const { submitWhitelist } = await import("@/lib/xstocks"); return await submitWhitelist({ walletAddress, chain, signature, challenge }); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_trades_summary: tool({
      description: "Get aggregated trading statistics for the xStocks account — call when user asks 'show me my xStocks trading overview', 'how much have I traded?', or wants a top-level dashboard of their activity.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getTradesSummary } = await import("@/lib/xstocks"); return await getTradesSummary(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_list_trades: tool({
      description: "List trade history for the xStocks account — call when user asks 'show my xStocks trades', 'what have I bought/sold?', or wants to filter by symbol, type (xchange/market/inkind), status (pending/completed/failed), or date range.",
      inputSchema: z.object({
        symbol: z.string().optional().describe("Filter by stock symbol, e.g. AAPL"),
        type: z.string().optional().describe("Trade type: xchange (secondary market RFQ), market (primary issuance/redemption), inkind (xPort share delivery)"),
        status: z.string().optional().describe("Trade status: pending, completed, failed"),
        from: z.string().optional().describe("ISO 8601 start date"),
        to: z.string().optional().describe("ISO 8601 end date"),
        limit: z.number().optional().describe("Max results, default 50"),
        offset: z.number().optional().describe("Pagination offset"),
      }),
      execute: async (params) => {
        try { const { listTrades } = await import("@/lib/xstocks"); return await listTrades(params); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_trade: tool({
      description: "Get full details for a single xStocks trade by ID — call when user asks about a specific trade, wants to check its status, or pastes a trade ID.",
      inputSchema: z.object({ id: z.string().describe("Trade UUID from xstocks_list_trades or a previous RFQ") }),
      execute: async ({ id }) => {
        try { const { getTrade } = await import("@/lib/xstocks"); return await getTrade(id); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_xchange_soft_rfq: tool({
      description: "Get an indicative (non-binding) price quote for buying or selling a tokenized stock on xStocks xChange — ALWAYS call this first before a firm RFQ to show the user an estimated price. Provide either quantity (number of tokens) OR notional (USD amount), not both.",
      inputSchema: z.object({
        symbol: z.string().describe("Stock ticker symbol, e.g. AAPL, TSLA"),
        side: z.enum(["buy", "sell"]).describe("buy = acquiring tokens, sell = disposing tokens"),
        quantity: z.number().optional().describe("Number of tokens to buy/sell — use this OR notional, not both"),
        notional: z.number().optional().describe("USD amount to spend/receive — use this OR quantity, not both"),
      }),
      execute: async ({ symbol, side, quantity, notional }) => {
        try { const { createXchangeRfqSoft } = await import("@/lib/xstocks"); return await createXchangeRfqSoft({ symbol, side, quantity, notional }); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_xchange_rfq: tool({
      description: "Create a firm executable xChange RFQ quote to buy or sell a tokenized stock — only call this AFTER showing the user a soft RFQ and receiving their explicit confirmation. This locks in a real quote with an expiry. Provide quantity OR notional, not both.",
      inputSchema: z.object({
        symbol: z.string().describe("Stock ticker symbol"),
        side: z.enum(["buy", "sell"]),
        quantity: z.number().optional().describe("Number of tokens — use this OR notional"),
        notional: z.number().optional().describe("USD amount — use this OR quantity"),
        walletAddress: z.string().optional().describe("User's wallet address for settlement"),
        chain: z.string().optional().describe("Settlement chain, e.g. ethereum, polygon"),
      }),
      execute: async ({ symbol, side, quantity, notional, walletAddress, chain }) => {
        try { const { createXchangeRfq } = await import("@/lib/xstocks"); return await createXchangeRfq({ symbol, side, quantity, notional, walletAddress, chain }); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_xchange_quote: tool({
      description: "Fetch a previously created xChange RFQ quote by ID — use to check if a quote is still valid, get updated status, or retrieve settlement instructions after a firm RFQ.",
      inputSchema: z.object({ id: z.string().describe("Quote UUID from xstocks_xchange_rfq") }),
      execute: async ({ id }) => {
        try { const { getXchangeQuote } = await import("@/lib/xstocks"); return await getXchangeQuote(id); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_list_xchange_assets: tool({
      description: "List all stocks available for secondary market (xChange RFQ) trading — call when user asks 'what can I trade on xChange?', 'which stocks are tradeable?', or before starting an RFQ to confirm the stock is available.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { listXchangeAssets } = await import("@/lib/xstocks"); return await listXchangeAssets(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_get_xchange_asset: tool({
      description: "Get trading details (min/max size, settlement chains, fees) for a specific xChange asset — call before an RFQ to check trading parameters or when user asks about limits for a specific stock.",
      inputSchema: z.object({ identifier: z.string().describe("Stock symbol or asset ID, e.g. AAPL") }),
      execute: async ({ identifier }) => {
        try { const { getXchangeAsset } = await import("@/lib/xstocks"); return await getXchangeAsset(identifier); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_market_fees: tool({
      description: "Get the fee schedule for xStocks primary market trades (institutional minting and redemption) — call when user asks about fees for primary issuance or direct redemption of tokens for underlying shares.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getMarketFees } = await import("@/lib/xstocks"); return await getMarketFees(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_market_issuance_wallets: tool({
      description: "Get the sweeping wallet addresses for primary token issuance (minting new xStock tokens) — for institutional participants who want to mint tokens by delivering the underlying shares.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getMarketIssuanceWallets } = await import("@/lib/xstocks"); return await getMarketIssuanceWallets(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_market_redemption_wallets: tool({
      description: "Get the sweeping wallet addresses for primary token redemption (burning xStock tokens to receive the underlying share) — for institutional participants redeeming tokens for physical shares.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getMarketRedemptionWallets } = await import("@/lib/xstocks"); return await getMarketRedemptionWallets(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_inkind_sweeping_wallets: tool({
      description: "Get sweeping wallets for xPort in-kind trades (deliver actual shares rather than cash settlement) — for institutional xPort workflows where shares change hands directly.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getInkindSweepingWallets } = await import("@/lib/xstocks"); return await getInkindSweepingWallets(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_list_bridges: tool({
      description: "List all authenticated cross-chain bridge routes for xStocks tokens — call when user wants to move tokens between chains and needs the full list including details only available with API key.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { listBridges } = await import("@/lib/xstocks"); return await listBridges(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    xstocks_bridge_sweeping_wallets: tool({
      description: "Get the wallet addresses used to receive tokens during cross-chain bridging on xStocks — call when user is ready to initiate a bridge transfer and needs the destination sweeping wallet.",
      inputSchema: z.object({}),
      execute: async () => {
        try { const { getBridgeSweepingWallets } = await import("@/lib/xstocks"); return await getBridgeSweepingWallets(); }
        catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ── dYdX Chain v4 ─────────────────────────────────────────────────────────

    dydx_list_markets: tool({
      description:
        "List all active perpetual markets on dYdX Chain v4 with current oracle price, 24h volume, open interest, funding rate, and status. " +
        "Call when user asks 'what markets does dYdX have?', 'show me dYdX markets', or wants to browse available perps.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "listPerpetualMarkets" }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_market: tool({
      description:
        "Get configuration and live prices for a single dYdX perpetual market by ticker (e.g. 'BTC-USD'). " +
        "Returns oracle price, index price, mark price, funding rate, open interest, market status, step size, and tick size. " +
        "Use this for market parameters and pricing. For 24h trading statistics (volume, trade count, price change %) use dydx_get_market_stats instead. " +
        "Call when user asks 'show me BTC-USD on dYdX', 'what are the tick/step sizes for ETH-USD?', or 'is this market active?'.",
      inputSchema: z.object({
        ticker: z.string().describe("Market ticker, e.g. BTC-USD, ETH-USD, SOL-USD"),
      }),
      execute: async ({ ticker }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getPerpetualMarket", ticker }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_orderbook: tool({
      description:
        "Fetch the current order book (bids and asks) for a dYdX perpetual market. " +
        "Call when user asks 'show me the order book for BTC-USD on dYdX' or wants to see liquidity depth.",
      inputSchema: z.object({
        ticker: z.string().describe("Market ticker, e.g. BTC-USD"),
      }),
      execute: async ({ ticker }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getOrderbook", ticker }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_candles: tool({
      description:
        "Get OHLCV candlestick data for a dYdX perpetual market. " +
        "Call when user asks for price history, chart data, or 'how has BTC-USD moved on dYdX?'. " +
        "Resolution options: 1MIN, 5MINS, 15MINS, 30MINS, 1HOUR, 4HOURS, 1DAY. Default to 1HOUR if the user doesn't specify.",
      inputSchema: z.object({
        ticker: z.string().describe("Market ticker, e.g. BTC-USD"),
        resolution: z.enum(["1MIN", "5MINS", "15MINS", "30MINS", "1HOUR", "4HOURS", "1DAY"]).describe("Candle timeframe"),
        limit: z.number().optional().describe("Number of candles to return, default 100"),
        fromISO: z.string().optional().describe("Start time ISO 8601"),
        toISO: z.string().optional().describe("End time ISO 8601"),
      }),
      execute: async ({ ticker, resolution, limit, fromISO, toISO }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getCandles", ticker, resolution, limit, fromISO, toISO }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_trades: tool({
      description:
        "Get the most recent public trades executed on a dYdX perpetual market — the market-wide execution feed, not the user's own fills. " +
        "Call when user asks 'show me recent trades on ETH-USD', 'what just traded on BTC-USD?', or wants to see the public tape. " +
        "For a user's own order executions use dydx_get_fills instead.",
      inputSchema: z.object({
        ticker: z.string().describe("Market ticker, e.g. ETH-USD"),
        limit: z.number().optional().describe("Number of trades to return, default 50"),
      }),
      execute: async ({ ticker, limit }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getMarketTrades", ticker, limit }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_market_stats: tool({
      description:
        "Get 24h trading statistics for a dYdX perpetual market: volume, trade count, price change %, open interest, and current funding rate. " +
        "Call when user asks '24h volume', 'how many trades on BTC-USD?', 'how much has price changed today?', or wants a market metrics summary.",
      inputSchema: z.object({
        ticker: z.string().describe("Market ticker, e.g. BTC-USD"),
      }),
      execute: async ({ ticker }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getMarketStats", ticker }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_historical_funding: tool({
      description:
        "Get per-hour historical funding rates for a specific dYdX perpetual market. " +
        "Call when user asks 'what's the funding rate history for BTC-USD on dYdX?', 'show me past funding rates', or wants to analyse the cost of holding a perp over time.",
      inputSchema: z.object({
        ticker: z.string().describe("Market ticker, e.g. BTC-USD, ETH-USD"),
        limit: z.number().optional().describe("Number of funding rate entries to return, default 48"),
        effectiveBeforeOrAt: z.string().optional().describe("Return rates effective before this ISO timestamp"),
      }),
      execute: async ({ ticker, limit, effectiveBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getHistoricalFunding", ticker, limit, effectiveBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_account: tool({
      description:
        "Look up a dYdX account and all its subaccounts by dYdX address (starts with 'dydx1...'). " +
        "Returns equity, USDC collateral, open positions, and subaccount list. " +
        "Call when user asks 'show my dYdX account', 'what's my dYdX balance?', or provides their dYdX address.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address starting with dydx1"),
      }),
      execute: async ({ address }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getAccount", address }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_subaccount: tool({
      description:
        "Get details for a specific dYdX subaccount (0–127 are cross-margin subaccounts). " +
        "Returns equity, free collateral, USDC balance, and open perp positions. " +
        "Call after dydx_get_account to drill into a subaccount, or when user specifies a subaccount number.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number 0–127, default 0"),
      }),
      execute: async ({ address, subaccountNumber }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getSubaccount", address, subaccountNumber }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_positions: tool({
      description:
        "Get open or closed perpetual positions for a dYdX subaccount. " +
        "Returns size, entry price, unrealized PnL, leverage, liquidation price. " +
        "Call when user asks 'show my dYdX positions', 'what positions do I have open on dYdX?', or 'am I long BTC on dYdX?'.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
        status: z.enum(["OPEN", "CLOSED", "LIQUIDATED"]).optional().describe("Filter by position status"),
        ticker: z.string().optional().describe("Filter to a specific market, e.g. BTC-USD"),
      }),
      execute: async ({ address, subaccountNumber, status, ticker }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getPerpetualPositions", address, subaccountNumber, status, ticker }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_orders: tool({
      description:
        "List orders for a dYdX subaccount — open, filled, or cancelled. " +
        "Call when user asks 'show my dYdX orders', 'do I have any open orders on dYdX?', or wants to review pending orders.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
        status: z.enum(["OPEN", "FILLED", "CANCELED", "BEST_EFFORT_OPENED", "BEST_EFFORT_CANCELED"]).optional().describe("Filter by order status"),
        ticker: z.string().optional().describe("Filter to a market, e.g. ETH-USD"),
        side: z.enum(["BUY", "SELL"]).optional().describe("Filter to buy or sell orders"),
        limit: z.number().optional().describe("Number of orders to return"),
      }),
      execute: async ({ address, subaccountNumber, status, ticker, side, limit }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getOrders", address, subaccountNumber, status, ticker, side, limit }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_fills: tool({
      description:
        "Get the user's own order-level fill history for a dYdX subaccount — every individual order match with price, size, fee, and timestamp. " +
        "NOT the same as dydx_get_trade_history (which is position-level with P&L per round-trip). " +
        "Call when user asks 'show my executed orders', 'what fills did I get on dYdX?', or wants the raw order execution log.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
        ticker: z.string().optional().describe("Filter to a market, e.g. BTC-USD"),
        limit: z.number().optional().describe("Number of fills to return"),
        createdBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination — returns fills created at or before this time"),
      }),
      execute: async ({ address, subaccountNumber, ticker, limit, createdBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getFills", address, subaccountNumber, ticker, limit, createdBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_transfers: tool({
      description:
        "Get deposit and withdrawal history for a dYdX subaccount. " +
        "Call when user asks 'show my dYdX deposits', 'how much have I deposited to dYdX?', or 'show transfer history on dYdX'.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
        limit: z.number().optional().describe("Number of transfers to return"),
        createdBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination — returns transfers created at or before this time"),
      }),
      execute: async ({ address, subaccountNumber, limit, createdBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getTransfers", address, subaccountNumber, limit, createdBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_pnl_history: tool({
      description:
        "Get irregular P&L snapshots for a dYdX subaccount — snapshots are triggered by position changes, not fixed intervals. " +
        "Use dydx_get_pnl instead when the user wants hourly data or a chart. " +
        "Call this when user asks 'show my dYdX P&L history', 'how has my equity changed?', or wants to see exact moments when P&L changed.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
        limit: z.number().optional().describe("Number of snapshots to return"),
        createdBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination — returns snapshots created at or before this time"),
      }),
      execute: async ({ address, subaccountNumber, limit, createdBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getHistoricalPnl", address, subaccountNumber, limit, createdBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_funding_payments: tool({
      description:
        "Get funding rate payments received or paid for perpetual positions on dYdX. " +
        "Call when user asks 'how much funding have I paid on dYdX?', 'show my dYdX funding history', or asks about the cost of holding a position.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
        ticker: z.string().optional().describe("Filter to a market, e.g. BTC-USD"),
        limit: z.number().optional().describe("Number of payments to return"),
      }),
      execute: async ({ address, subaccountNumber, ticker, limit }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getFundingPayments", address, subaccountNumber, ticker, limit }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_asset_positions: tool({
      description:
        "Get USDC and other collateral asset balances in a dYdX subaccount. " +
        "Call when user asks 'how much USDC do I have on dYdX?', 'what's my dYdX collateral balance?', or needs to see non-perp asset holdings.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
      }),
      execute: async ({ address, subaccountNumber }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getAssetPositions", address, subaccountNumber }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_order: tool({
      description:
        "Get full details for a specific dYdX order by its order ID. " +
        "Call when user provides an order ID and asks about its status, fill amount, or remaining size.",
      inputSchema: z.object({
        orderId: z.string().describe("The dYdX order ID string"),
      }),
      execute: async ({ orderId }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getOrder", orderId }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_server_time: tool({
      description:
        "Get the dYdX Indexer server time as an ISO string and Unix epoch. " +
        "Call when user asks for the current dYdX time, or to check indexer health/latency.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getServerTime" }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_sparklines: tool({
      description:
        "Get mini price sparkline data for ALL dYdX perpetual markets for the past 1 or 7 days. " +
        "Call when user asks for a quick overview of which markets are up/down, or wants a dashboard-style price summary.",
      inputSchema: z.object({
        timePeriod: z.enum(["ONE_DAY", "SEVEN_DAYS"]).default("ONE_DAY").describe("Sparkline time window"),
      }),
      execute: async ({ timePeriod }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getSparklines", timePeriod }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_block_trading_rewards: tool({
      description:
        "Get historical block-by-block DYDX trading reward grants for a dYdX address. " +
        "Call when user asks for a detailed reward history or wants to audit exactly when rewards were distributed.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        limit: z.number().optional().describe("Number of reward entries to return"),
        startingBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination — returns rewards starting before or at this time"),
      }),
      execute: async ({ address, limit, startingBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getHistoricalBlockTradingRewards", address, limit, startingBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_reward_aggregations: tool({
      description:
        "Get paginated historical aggregated DYDX trading rewards for an address by period (DAILY/WEEKLY/MONTHLY). " +
        "Call when user asks 'show my full DYDX reward history', 'how many DYDX rewards have I earned?', or wants to scroll back through past reward periods.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).optional().describe("Aggregation period: DAILY, WEEKLY, or MONTHLY"),
        limit: z.number().optional().describe("Number of reward periods to return"),
        startingBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination — returns periods starting before or at this time"),
      }),
      execute: async ({ address, period, limit, startingBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getHistoricalTradingRewardAggregations", address, period, limit, startingBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_megavault_shares: tool({
      description:
        "Get a user's current and historical share balance in the dYdX Megavault. " +
        "Call when user asks 'do I have shares in the dYdX Megavault?', 'how much have I deposited in the dYdX vault?', or 'show my Megavault position'.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        includeHistory: z.boolean().default(false).describe("Also fetch historical share snapshots"),
        limit: z.number().optional().describe("Number of history entries if includeHistory=true"),
        createdBeforeOrAt: z.string().optional().describe("ISO timestamp for paginating historical snapshots (only applies when includeHistory=true)"),
      }),
      execute: async ({ address, includeHistory, limit, createdBeforeOrAt }) => {
        try {
          const [sharesRes, histRes] = await Promise.all([
            fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getMegavaultOwnerShares", address }) }),
            includeHistory
              ? fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getMegavaultHistoricalOwnerShares", address, limit, createdBeforeOrAt }) })
              : null,
          ]);
          const sharesJson = await sharesRes.json();
          const shares = sharesRes.ok ? (sharesJson.result ?? sharesJson) : { error: sharesJson.error ?? "Failed" };
          let history = null;
          if (histRes) {
            const histJson = await histRes.json();
            history = histRes.ok ? (histJson.result ?? histJson) : { error: histJson.error ?? "Failed" };
          }
          return { shares, history };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_megavault: tool({
      description:
        "Get the dYdX Megavault's current open positions and historical P&L. " +
        "Call when user asks about 'the dYdX vault', 'Megavault performance', 'how is dYdX's liquidity vault doing?', or wants to understand the protocol-owned liquidity. " +
        "Returns positions across all markets and equity-curve snapshots.",
      inputSchema: z.object({
        includeHistory: z.boolean().default(true).describe("Also fetch historical P&L snapshots"),
        resolution: z.enum(["day", "hour"]).optional().describe("P&L snapshot resolution"),
        limit: z.number().optional().describe("Number of P&L snapshots"),
      }),
      execute: async ({ includeHistory, resolution, limit }) => {
        try {
          const [posRes, pnlRes] = await Promise.all([
            fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getMegavaultPositions" }) }),
            includeHistory
              ? fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getMegavaultHistoricalPnl", resolution, limit }) })
              : null,
          ]);
          const posJson = await posRes.json();
          const positions = posRes.ok ? (posJson.result ?? posJson) : { error: posJson.error ?? "Failed" };
          let pnlHistory = null;
          if (pnlRes) {
            const pnlJson = await pnlRes.json();
            pnlHistory = pnlRes.ok ? (pnlJson.result ?? pnlJson) : { error: pnlJson.error ?? "Failed" };
          }
          return { positions, pnlHistory };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_vault_positions: tool({
      description:
        "Get the current open perpetual positions held by each individual dYdX vault market (not the aggregate Megavault). " +
        "Call when user asks 'what positions does each dYdX vault hold?', 'show individual vault positions', or wants to see how each market vault is deployed. " +
        "For the aggregate Megavault use dydx_get_megavault; for per-vault historical P&L use dydx_get_vaults_historical_pnl.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getVaultPositions" }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_block_height: tool({
      description:
        "Get the current dYdX Chain block height and timestamp. " +
        "Call when user asks about chain status, current block, or wants to verify the indexer is live.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getBlockHeight" }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_parent_subaccount: tool({
      description:
        "Get the cross-margin parent subaccount view for a dYdX address — equity, free collateral, and all child subaccounts rolled up. " +
        "Call when user asks 'show my cross-margin account', 'what's my total dYdX equity across subaccounts?', or has multiple subaccounts.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
      }),
      execute: async ({ address, parentSubaccountNumber }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getParentSubaccount", address, parentSubaccountNumber }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_positions_parent: tool({
      description:
        "Get perpetual positions rolled up across all child subaccounts under a dYdX parent subaccount. " +
        "Call when user has multiple isolated subaccounts and asks for an aggregate position view.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
        status: z.enum(["OPEN", "CLOSED", "LIQUIDATED"]).optional().describe("Filter by position status"),
        ticker: z.string().optional().describe("Filter to a specific market, e.g. BTC-USD"),
      }),
      execute: async ({ address, parentSubaccountNumber, status, ticker }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getPerpetualPositionsParent", address, parentSubaccountNumber, status, ticker }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_orders_parent: tool({
      description:
        "Get orders across all child subaccounts under a dYdX parent subaccount. " +
        "Call when user asks for aggregate open orders across all their dYdX subaccounts.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
        status: z.enum(["OPEN", "FILLED", "CANCELED"]).optional().describe("Filter by order status"),
        ticker: z.string().optional().describe("Filter to a specific market, e.g. ETH-USD"),
        limit: z.number().optional().describe("Number of orders to return"),
      }),
      execute: async ({ address, parentSubaccountNumber, status, ticker, limit }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getOrdersParent", address, parentSubaccountNumber, status, ticker, limit }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_trade_history: tool({
      description:
        "Get position-level trade history for a dYdX subaccount — each entry shows open/close action, execution price, entry price, and per-trade P&L. " +
        "Different from dydx_get_fills (order-level). Call when user asks 'show my trade history', 'what trades did I open/close?', or wants P&L per trade.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
        ticker: z.string().optional().describe("Filter to a specific market, e.g. BTC-USD"),
        limit: z.number().optional().describe("Number of trade history entries to return"),
      }),
      execute: async ({ address, subaccountNumber, ticker, limit }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getTradeHistory", address, subaccountNumber, ticker, limit }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_pnl: tool({
      description:
        "Get hourly-bucketed P&L and equity snapshots for a dYdX subaccount. " +
        "Different from dydx_get_pnl_history which uses irregular snapshot intervals. " +
        "Call when user wants hourly P&L data or an equity chart with hourly resolution.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        subaccountNumber: z.number().default(0).describe("Subaccount number, default 0"),
        limit: z.number().optional().describe("Number of hourly snapshots to return"),
        createdBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination — returns snapshots created at or before this time"),
      }),
      execute: async ({ address, subaccountNumber, limit, createdBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getPnl", address, subaccountNumber, limit, createdBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_transfers_between: tool({
      description:
        "Get all transfers between two specific dYdX subaccounts and their net total. " +
        "Call when user asks 'how much have I transferred between my subaccounts?', 'show transfers between address A and address B', or wants to reconcile inter-account flows.",
      inputSchema: z.object({
        sourceAddress: z.string().describe("Sender dYdX address (dydx1...)"),
        sourceSubaccountNumber: z.number().default(0).describe("Sender subaccount number, default 0"),
        recipientAddress: z.string().describe("Recipient dYdX address (dydx1...)"),
        recipientSubaccountNumber: z.number().default(0).describe("Recipient subaccount number, default 0"),
      }),
      execute: async ({ sourceAddress, sourceSubaccountNumber, recipientAddress, recipientSubaccountNumber }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getTransfersBetween", sourceAddress, sourceSubaccountNumber, recipientAddress, recipientSubaccountNumber }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_search_trader: tool({
      description:
        "Search for a dYdX trader by address or username. Returns their address, subaccountId, and username. " +
        "Call when user provides a username or partial address and asks 'who is this dYdX trader?', 'find trader [name]', or wants to resolve a username to an address.",
      inputSchema: z.object({
        searchParam: z.string().describe("dYdX address (dydx1...) or username to search for"),
      }),
      execute: async ({ searchParam }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "searchTrader", searchParam }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_asset_positions_parent: tool({
      description:
        "Get USDC and collateral asset balances aggregated across all child subaccounts under a dYdX parent subaccount. " +
        "Call when user asks 'what's my total USDC across all my dYdX subaccounts?' or has multiple isolated subaccounts.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
      }),
      execute: async ({ address, parentSubaccountNumber }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getAssetPositionsParent", address, parentSubaccountNumber }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_funding_payments_parent: tool({
      description:
        "Get funding rate payments aggregated across all child subaccounts under a dYdX parent subaccount. " +
        "Call when user asks 'how much total funding have I paid/received across all my dYdX subaccounts?'.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
        ticker: z.string().optional().describe("Filter to a specific market, e.g. BTC-USD"),
        limit: z.number().optional().describe("Number of payment records to return"),
      }),
      execute: async ({ address, parentSubaccountNumber, ticker, limit }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getFundingPaymentsParent", address, parentSubaccountNumber, ticker, limit }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_historical_pnl_parent: tool({
      description:
        "Get equity-curve P&L snapshots aggregated across all child subaccounts under a dYdX parent subaccount. " +
        "Call when user asks 'show my overall dYdX P&L history across all subaccounts' or wants a rolled-up equity curve.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
        limit: z.number().optional().describe("Number of snapshots to return"),
        createdBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination"),
      }),
      execute: async ({ address, parentSubaccountNumber, limit, createdBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getHistoricalPnlParent", address, parentSubaccountNumber, limit, createdBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_pnl_parent: tool({
      description:
        "Get hourly-bucketed P&L and equity snapshots aggregated across all child subaccounts under a dYdX parent subaccount. " +
        "Call when user wants an hourly equity chart rolled up across all their dYdX subaccounts.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
        limit: z.number().optional().describe("Number of hourly snapshots to return"),
        createdBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination — returns snapshots created at or before this time"),
      }),
      execute: async ({ address, parentSubaccountNumber, limit, createdBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getPnlParent", address, parentSubaccountNumber, limit, createdBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_trade_history_parent: tool({
      description:
        "Get position-level trade history aggregated across all child subaccounts under a dYdX parent subaccount. " +
        "Returns open/close actions with entry/exit price and P&L per trade across all subaccounts. " +
        "Call when user wants a complete trade history rolled up across all their dYdX subaccounts.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
        ticker: z.string().optional().describe("Filter to a specific market, e.g. BTC-USD"),
        limit: z.number().optional().describe("Number of trade history entries to return"),
      }),
      execute: async ({ address, parentSubaccountNumber, ticker, limit }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getTradeHistoryParent", address, parentSubaccountNumber, ticker, limit }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_transfers_parent: tool({
      description:
        "Get deposit, withdrawal, and internal transfer history aggregated across all child subaccounts under a dYdX parent subaccount. " +
        "Call when user asks 'show all my dYdX transfers across subaccounts' or wants an aggregate deposit/withdrawal history.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
        parentSubaccountNumber: z.number().default(0).describe("Parent subaccount number 0–127, default 0"),
        limit: z.number().optional().describe("Number of transfers to return"),
        createdBeforeOrAt: z.string().optional().describe("ISO timestamp for pagination"),
      }),
      execute: async ({ address, parentSubaccountNumber, limit, createdBeforeOrAt }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getTransfersParent", address, parentSubaccountNumber, limit, createdBeforeOrAt }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_vaults_historical_pnl: tool({
      description:
        "Get historical P&L snapshots for every individual dYdX vault market (not the aggregate Megavault). " +
        "Call when user asks 'how has each dYdX vault performed?', 'show per-market vault P&L', or wants to compare individual vault performance.",
      inputSchema: z.object({
        resolution: z.enum(["day", "hour"]).optional().describe("Snapshot resolution — 'day' or 'hour'"),
        limit: z.number().optional().describe("Number of P&L snapshots to return per vault"),
      }),
      execute: async ({ resolution, limit }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getVaultsHistoricalPnl", resolution, limit }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_compliance_screen: tool({
      description:
        "Get the full compliance status for a dYdX address: COMPLIANT or BLOCKED, with reason and last-updated timestamp. " +
        "More detailed than dydx_screen_address. Call when user asks 'why is my dYdX account restricted?', 'show my compliance status', or needs the reason for a block.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address starting with dydx1"),
      }),
      execute: async ({ address }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getComplianceScreen", address }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_screen_address: tool({
      description:
        "Check whether a dYdX address is geo/compliance restricted. Returns { restricted: true/false }. " +
        "Call when user asks 'is my dYdX address blocked?', 'am I restricted on dYdX?', or before explaining why an address cannot trade.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address starting with dydx1"),
      }),
      execute: async ({ address }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "screenAddress", address }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_affiliate_metadata: tool({
      description:
        "Get affiliate/referral metadata for a dYdX address: their referral code, whether they are volume-eligible, and whether they are an active affiliate. " +
        "Call when user asks 'what's my dYdX referral code?', 'am I a dYdX affiliate?', or 'show my affiliate status on dYdX'.",
      inputSchema: z.object({
        address: z.string().describe("dYdX chain address"),
      }),
      execute: async ({ address }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getAffiliateMetadata", address }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_affiliate_by_referral_code: tool({
      description:
        "Resolve a dYdX referral code to the affiliate's address. " +
        "Call when user provides a referral code and asks 'who referred me?', 'whose referral code is this?', or wants to look up an affiliate by code.",
      inputSchema: z.object({
        referralCode: z.string().describe("The dYdX referral code string, e.g. RapidSpy0CK"),
      }),
      execute: async ({ referralCode }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getAffiliateAddressByReferralCode", referralCode }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    dydx_get_affiliates_snapshot: tool({
      description:
        "Get a paginated leaderboard of top dYdX affiliates with their earnings, referred users, referred volume, and referral codes. " +
        "Call when user asks 'who are the top dYdX affiliates?', 'show the dYdX referral leaderboard', or wants to compare affiliate performance.",
      inputSchema: z.object({
        limit: z.number().optional().describe("Number of affiliates to return, default 20"),
        offset: z.number().optional().describe("Pagination offset"),
        sortByAffiliateEarning: z.boolean().optional().describe("Sort by earnings (true) or referred volume (false/omit)"),
      }),
      execute: async ({ limit, offset, sortByAffiliateEarning }) => {
        try {
          const r = await fetch(`${appBase()}/api/dydx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "getAffiliatesSnapshot", limit, offset, sortByAffiliateEarning }) });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Banking Providers ────────────────────────────────────────────────────

    get_banking_providers: tool({
      description:
        "List all configured banking providers (e.g. Credible, Paycrest, MoonPay). " +
        "Returns each provider's id, name, and supported features. " +
        "Call first when the user asks which banking provider to use or which providers are available.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/banking/providers`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_banking_balance: tool({
      description:
        "Get the banking wallet balance for a provider (e.g. Credible). " +
        "Returns USDC/fiat balance in the provider's main sub-account. " +
        "Use when user asks 'what's my Credible balance?' or before initiating payouts.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        sub_account_id: z.string().optional().describe("Sub-account ID, defaults to 'main'"),
      }),
      execute: async ({ provider, sub_account_id }) => {
        try {
          const params = new URLSearchParams();
          if (sub_account_id) params.set("sub_account_id", sub_account_id);
          const r = await fetch(`${appBase()}/api/banking/${provider}/balance?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Banking Payout Suite ─────────────────────────────────────────────────

    get_payout_balance: tool({
      description:
        "Get the payout wallet balance for a banking provider — how much is available to disburse to bank accounts. " +
        "Call when user asks 'how much can I payout?' or before sending a payout.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        currency: z.string().optional().describe("Currency code, e.g. 'inr', 'usd'. Defaults to 'usd'"),
      }),
      execute: async ({ provider, currency }) => {
        try {
          const params = new URLSearchParams();
          if (currency) params.set("currency", currency);
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/balance?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_payout_deposit_address: tool({
      description:
        "Get the on-chain deposit address for topping up the payout wallet of a banking provider. " +
        "The user sends crypto to this address to fund the payout wallet, which can then be used for bank payouts. " +
        "Call when user asks 'how do I fund payouts?' or 'give me the deposit address for payouts'.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        currency: z.string().optional().describe("Crypto to deposit, e.g. 'USDT'. Defaults to 'USDT'"),
        blockchain: z.string().optional().describe("Blockchain, e.g. 'ethereum', 'tron'. Defaults to 'ethereum'"),
        chain: z.string().optional().describe("Chain variant if needed"),
        sub_account_id: z.string().optional().describe("Sub-account ID, defaults to 'main'"),
      }),
      execute: async ({ provider, currency, blockchain, chain, sub_account_id }) => {
        try {
          const params = new URLSearchParams();
          if (currency) params.set("currency", currency);
          if (blockchain) params.set("blockchain", blockchain);
          if (chain) params.set("chain", chain);
          if (sub_account_id) params.set("sub_account_id", sub_account_id);
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/deposit-address?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_payout_fx_rate: tool({
      description:
        "Get the current FX rate for a payout currency pair (e.g. USDT → INR). " +
        "Call before initiating a payout so the user knows the effective exchange rate.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        input_currency: z.string().optional().describe("Source currency, e.g. 'USDT'"),
        output_currency: z.string().optional().describe("Target fiat currency, e.g. 'INR'"),
        type: z.string().optional().describe("Transaction type, e.g. 'payout'"),
        purpose: z.string().optional().describe("Transaction purpose"),
        party: z.string().optional().describe("Transaction party"),
      }),
      execute: async ({ provider, input_currency, output_currency, type, purpose, party }) => {
        try {
          const params = new URLSearchParams();
          if (input_currency) params.set("input_currency", input_currency);
          if (output_currency) params.set("output_currency", output_currency);
          if (type) params.set("type", type);
          if (purpose) params.set("purpose", purpose);
          if (party) params.set("party", party);
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/fx-rate?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    validate_payout_bank_account: tool({
      description:
        "Validate a bank account before initiating a payout — verifies account number, IFSC, and account holder name are correct. " +
        "ALWAYS call this before initiate_payout when the user provides bank details for the first time. " +
        "Supports INR bank accounts. Returns validation status and account holder details.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        currency: z.string().describe("Currency code, e.g. 'inr'"),
        account_number: z.string().describe("Bank account number"),
        ifsc: z.string().describe("IFSC code for Indian banks"),
        account_holder_name: z.string().describe("Account holder's full name"),
        sub_account_id: z.string().optional().describe("Sub-account ID if applicable"),
        wallet: z.string().optional().describe("Wallet address if applicable"),
      }),
      execute: async ({ provider, currency, account_number, ifsc, account_holder_name, sub_account_id, wallet }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/validate-account`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currency, account_number, ifsc, account_holder_name, sub_account_id, wallet }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    initiate_payout: tool({
      description:
        "Send a fiat payout from the platform's payout wallet to a bank account. " +
        "Supports INR (bank transfer), IDR (Indonesia), PHP (Philippines), and VND (Vietnam). " +
        "IMPORTANT: Always validate the bank account with validate_payout_bank_account first, and show the FX rate from get_payout_fx_rate before confirming. " +
        "CONFIRM with the user before calling this — payouts are irreversible.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        currency: z.enum(["inr", "inr_e", "idr", "php", "vnd"]).describe("Target payout currency"),
        amount: z.number().positive().describe("Amount to payout in the target currency"),
        account_holder_name: z.string().describe("Beneficiary's full name"),
        account_number: z.string().optional().describe("Bank account number (required for INR/IDR/PHP/VND)"),
        ifsc: z.string().optional().describe("IFSC code (required for INR bank transfers)"),
        upi_id: z.string().optional().describe("UPI ID (alternative to account+IFSC for INR)"),
        bank_code: z.string().optional().describe("Bank code for IDR/PHP/VND"),
        merchant_payout_id: z.string().optional().describe("Your unique reference for this payout"),
        purpose: z.string().optional().describe("Purpose of the payout, e.g. 'salary', 'vendor_payment'"),
      }),
      execute: async ({ provider, currency, amount, ...rest }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currency, amount, ...rest }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    list_payouts: tool({
      description:
        "List payout transactions for a banking provider — shows status, amounts, beneficiary, and timestamps. " +
        "Call when user asks 'show my payouts', 'what's the status of my payout?', or needs to audit payout history.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        page: z.number().optional().describe("Page number, starts at 0"),
        limit: z.number().optional().describe("Results per page, default 10"),
        status: z.string().optional().describe("Filter by status, e.g. 'pending', 'completed', 'failed'"),
        payout_id: z.string().optional().describe("Fetch a specific payout by provider's payout ID"),
        merchant_payout_id: z.string().optional().describe("Fetch by your own reference ID"),
        sub_account_id: z.string().optional().describe("Filter by sub-account"),
      }),
      execute: async ({ provider, page, limit, status, payout_id, merchant_payout_id, sub_account_id }) => {
        try {
          const params = new URLSearchParams();
          if (page !== undefined) params.set("page", String(page));
          if (limit !== undefined) params.set("limit", String(limit));
          if (status) params.set("status", status);
          if (payout_id) params.set("payout_id", payout_id);
          if (merchant_payout_id) params.set("merchant_payout_id", merchant_payout_id);
          if (sub_account_id) params.set("sub_account_id", sub_account_id);
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/list?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_payout_wallet_ledger: tool({
      description:
        "Get the payout wallet ledger — a full transaction history of the payout wallet (deposits in, payouts out, fees). " +
        "Call when user wants to see payout wallet activity or reconcile payout wallet balance.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        page: z.number().optional().describe("Page number, starts at 0"),
        limit: z.number().optional().describe("Results per page, default 10"),
      }),
      execute: async ({ provider, page, limit }) => {
        try {
          const params = new URLSearchParams();
          if (page !== undefined) params.set("page", String(page));
          if (limit !== undefined) params.set("limit", String(limit));
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/wallet-ledger?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_payout_deposits: tool({
      description:
        "List crypto deposits that have been received into the payout wallet (top-ups sent by the platform). " +
        "Call when user asks 'have my funds arrived in the payout wallet?' or needs to reconcile incoming crypto.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        page: z.number().optional().describe("Page number, starts at 0"),
        limit: z.number().optional().describe("Results per page, default 10"),
        sub_account_id: z.string().optional().describe("Sub-account ID, defaults to 'main'"),
      }),
      execute: async ({ provider, page, limit, sub_account_id }) => {
        try {
          const params = new URLSearchParams();
          if (page !== undefined) params.set("page", String(page));
          if (limit !== undefined) params.set("limit", String(limit));
          if (sub_account_id) params.set("sub_account_id", sub_account_id);
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/deposits?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    transfer_to_payout_wallet: tool({
      description:
        "Transfer funds from the banking provider's main wallet into the payout wallet so they can be disbursed to bank accounts. " +
        "Call when user asks 'move funds to the payout wallet' or payout balance is insufficient.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        amount: z.number().positive().describe("Amount to transfer"),
        currency: z.string().optional().describe("Currency, e.g. 'INR'. Defaults to 'INR'"),
      }),
      execute: async ({ provider, amount, currency }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/transfer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount, currency }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Banking Offramp Bank Account Management ──────────────────────────────

    deactivate_offramp_bank_account: tool({
      description:
        "Deactivate (remove) a saved offramp bank account — prevents it from being used for future offramp orders. " +
        "Call when user says 'remove my bank account', 'delete my saved bank', or 'I want to use a different account'. " +
        "Always confirm with the user before deactivating.",
      inputSchema: z.object({
        provider: z.string().describe("Banking provider ID, e.g. 'credible'"),
        bank_account_id: z.string().describe("Bank account ID from get_offramp_bank_accounts"),
      }),
      execute: async ({ provider, bank_account_id }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/offramp/bank-accounts/deactivate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bank_account_id }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    review_offramp_bank_account: tool({
      description:
        "Submit a bank account for manual review / penny-drop verification by the banking provider. " +
        "Call when the user wants to add a new bank account but it hasn't been penny-drop verified yet. " +
        "Returns a review status and any required next steps from the provider.",
      inputSchema: z.object({
        provider: z.string().describe("Banking provider ID, e.g. 'credible'"),
        first_name: z.string().describe("Account holder's first name"),
        last_name: z.string().describe("Account holder's last name"),
        account_number: z.string().describe("Bank account number"),
        ifsc: z.string().describe("IFSC code for the bank branch"),
      }),
      execute: async ({ provider, first_name, last_name, account_number, ifsc }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/offramp/bank-accounts/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ first_name, last_name, account_number, ifsc }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Banking Payout Trade (currency swap within payout wallet) ─────────────

    banking_payout_trade: tool({
      description:
        "Swap currencies within the banking payout wallet (e.g. USDT → INR, USDC → IDR). " +
        "Different from a regular payout — this exchanges one currency for another inside the payout wallet balance without sending to a bank. " +
        "Call when user asks 'convert USDT to INR in the payout wallet' or 'swap to local currency before paying out'. " +
        "Use get_payout_fx_rate first to show the rate.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        from_currency: z.string().describe("Source currency, e.g. 'USDT'"),
        to_currency: z.string().describe("Target currency, e.g. 'INR'"),
        from_amount: z.number().positive().describe("Amount to convert from the source currency"),
        sub_account_id: z.string().optional().describe("Sub-account to use, defaults to 'main'"),
        merchant_trade_id: z.string().optional().describe("Your unique reference for this trade"),
      }),
      execute: async ({ provider, from_currency, to_currency, from_amount, sub_account_id, merchant_trade_id }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/trade`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from_currency, to_currency, from_amount, sub_account_id, merchant_trade_id }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    list_banking_payout_trades: tool({
      description:
        "List completed currency trades/swaps in the banking payout wallet. " +
        "Call when user wants to see their payout wallet conversion history.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        page: z.number().optional().describe("Page number, starts at 1"),
        limit: z.number().optional().describe("Results per page, default 10"),
        from_currency: z.string().optional().describe("Filter by source currency"),
        to_currency: z.string().optional().describe("Filter by target currency"),
        sub_account_id: z.string().optional().describe("Filter by sub-account"),
      }),
      execute: async ({ provider, page, limit, from_currency, to_currency, sub_account_id }) => {
        try {
          const params = new URLSearchParams();
          if (page !== undefined) params.set("page", String(page));
          if (limit !== undefined) params.set("limit", String(limit));
          if (from_currency) params.set("from_currency", from_currency);
          if (to_currency) params.set("to_currency", to_currency);
          if (sub_account_id) params.set("sub_account_id", sub_account_id);
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/trade?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    send_payout: tool({
      description:
        "Initiate a fiat bank payout (withdraw from the banking payout wallet to a bank account). " +
        "Supports INR (India), IDR (Indonesia), PHP (Philippines), and VND (Vietnam). " +
        "ALWAYS call validate_payout_bank_account first when the user provides bank details for the first time. " +
        "Returns the payout order details on success.",
      inputSchema: z.object({
        provider: z.string().describe("Banking provider ID, e.g. 'credible'"),
        currency: z.enum(["inr", "inr_e", "idr", "php", "vnd"]).describe("Fiat currency to pay out"),
        amount: z.number().positive().describe("Amount in the local fiat currency"),
        account_holder_name: z.string().describe("Name of the bank account holder"),
        account_number: z.string().optional().describe("Bank account number (INR/IDR/PHP)"),
        ifsc: z.string().optional().describe("IFSC code for Indian bank accounts"),
        bank_code: z.string().optional().describe("Bank code for IDR/PHP payouts"),
        phone: z.string().optional().describe("Phone number for VND mobile payouts"),
        remarks: z.string().optional().describe("Payment reference or remarks"),
        sub_account_id: z.string().optional().describe("Sub-account to debit, default 'main'"),
      }),
      execute: async ({ provider, currency, amount, account_holder_name, ...rest }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currency, amount, account_holder_name, ...rest }),
          });
          const data = await r.json();
          if (!r.ok) return { error: data?.error ?? "Payout failed" };
          return data;
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    banking_transfer: tool({
      description:
        "Transfer funds from the main banking wallet to the payout wallet for a given provider. " +
        "Use this to top up the payout wallet balance before initiating bank payouts. " +
        "Call when the user says 'move funds to payout wallet' or 'top up the payout balance'.",
      inputSchema: z.object({
        provider: z.string().describe("Banking provider ID, e.g. 'credible'"),
        amount: z.number().positive().describe("Amount to transfer"),
        currency: z.string().optional().describe("Currency code, e.g. 'INR', 'USDT'. Defaults to 'INR'"),
      }),
      execute: async ({ provider, amount, currency }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/transfer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount, currency }),
          });
          const data = await r.json();
          if (!r.ok) return { error: data?.error ?? "Transfer failed" };
          return data;
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_banking_ledger: tool({
      description:
        "Get the transaction ledger (statement) for a banking provider's payout wallet. " +
        "Lists credits, debits, fees, and running balances. " +
        "Call when user asks 'show my payout wallet history', 'what transactions happened?', or 'get my banking ledger'.",
      inputSchema: z.object({
        provider: z.string().describe("Banking provider ID, e.g. 'credible'"),
        page: z.number().int().positive().optional().describe("Page number, starts at 1"),
        limit: z.number().int().positive().optional().describe("Results per page, default 20"),
      }),
      execute: async ({ provider, page, limit }) => {
        try {
          const params = new URLSearchParams();
          if (page !== undefined) params.set("page", String(page));
          if (limit !== undefined) params.set("limit", String(limit));
          const r = await fetch(`${appBase()}/api/banking/${provider}/ledger?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Banking Sub-accounts & Payout Info ──────────────────────────────────

    get_payout_credit_limit: tool({
      description:
        "Get the merchant payout credit limit for a banking provider. " +
        "Returns { available_credit, total_credit_limit, consumed_credit, currency }. " +
        "Call when user asks 'what is my payout credit limit?' or before a large payout to confirm headroom.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        currency: z.string().optional().describe("Currency code, e.g. 'usdt'. Defaults to 'usdt'"),
      }),
      execute: async ({ provider, currency }) => {
        try {
          const params = new URLSearchParams();
          if (currency) params.set("currency", currency);
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/credit-limit?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_payout_info: tool({
      description:
        "Get full details of a single payout by its ID — status, amount, beneficiary, timestamps, and failure reason if any. " +
        "Use payout_id (from send_payout or initiate_payout) or merchant_payout_id (your reference). " +
        "Call to check the status of a specific payout or explain a failure to the user.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        payout_id: z.string().optional().describe("Provider payout ID returned by send_payout"),
        merchant_payout_id: z.string().optional().describe("Your own reference ID (if you set one when creating the payout)"),
      }),
      execute: async ({ provider, payout_id, merchant_payout_id }) => {
        if (!payout_id && !merchant_payout_id) return { error: "payout_id or merchant_payout_id required" };
        try {
          const params = new URLSearchParams();
          if (payout_id) params.set("payout_id", payout_id);
          if (merchant_payout_id) params.set("merchant_payout_id", merchant_payout_id);
          const r = await fetch(`${appBase()}/api/banking/${provider}/payout/info?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    list_banking_sub_accounts: tool({
      description:
        "List all sub-accounts for a banking provider — each has a sub_account_id and label. " +
        "Sub-accounts let you segregate funds by team, product, or currency. " +
        "Call before creating a sub-account to see what already exists, or when user asks 'show my sub-accounts'.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        page: z.number().int().min(0).optional().describe("Page number, starts at 0"),
        limit: z.number().int().positive().optional().describe("Results per page, default 10"),
      }),
      execute: async ({ provider, page, limit }) => {
        try {
          const params = new URLSearchParams();
          if (page !== undefined) params.set("page", String(page));
          if (limit !== undefined) params.set("limit", String(limit));
          const r = await fetch(`${appBase()}/api/banking/${provider}/sub-accounts?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    create_banking_sub_account: tool({
      description:
        "Create a new sub-account under a banking provider — useful for segregating funds by team, currency, or product. " +
        "Returns { label, sub_account_id }. " +
        "Confirm with the user before creating — sub-accounts are persistent.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        label: z.string().optional().describe("Human-readable label for this sub-account, e.g. 'Marketing', 'Payroll'"),
      }),
      execute: async ({ provider, label }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/sub-accounts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_sub_account_balance: tool({
      description:
        "Get the balance of a specific sub-account for a banking provider. " +
        "Use sub_account_id from list_banking_sub_accounts ('main' for the primary account). " +
        "Call when user asks 'how much is in my payroll sub-account?' or 'what's the balance of sub-account X?'.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        sub_account_id: z.string().optional().describe("Sub-account ID from list_banking_sub_accounts. Defaults to 'main'"),
        currency: z.string().optional().describe("Currency to query, e.g. 'usd', 'usdt'. Defaults to 'usd'"),
      }),
      execute: async ({ provider, sub_account_id, currency }) => {
        try {
          const params = new URLSearchParams();
          if (currency) params.set("currency", currency);
          if (sub_account_id) params.set("sub_account_id", sub_account_id);
          const r = await fetch(`${appBase()}/api/banking/${provider}/sub-accounts/balance?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    transfer_sub_account_funds: tool({
      description:
        "Transfer funds between sub-accounts within a banking provider. " +
        "Returns { transfer_id } on success. " +
        "Use list_banking_sub_accounts to get valid sub_account_ids. " +
        "Omit from_sub_account_id to move FROM the main account; omit to_sub_account_id to move TO the main account. " +
        "CONFIRM with the user before transferring — internal transfers are irreversible.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        amount: z.number().positive().describe("Amount to transfer"),
        currency: z.string().describe("Currency to transfer, e.g. 'usdt', 'usd'"),
        from_sub_account_id: z.string().optional().describe("Source sub-account ID. Defaults to 'main'"),
        to_sub_account_id: z.string().optional().describe("Destination sub-account ID. Defaults to 'main'"),
      }),
      execute: async ({ provider, amount, currency, from_sub_account_id, to_sub_account_id }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/sub-accounts/transfer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount, currency, from_sub_account_id, to_sub_account_id }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Activity Narration ───────────────────────────────────────────────────

    get_activity_narration: tool({
      description:
        "Get an AI-generated 2-3 sentence narrative summary of the user's last 10 DeFi activities. " +
        "Uses DeepSeek to write a warm, jargon-free summary of what the user has been doing. " +
        "Call when user asks 'what have I been doing?', 'summarize my recent activity', or 'give me an overview of my DeFi activity'.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/activity/narrate`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Velvet Vault Preferences ─────────────────────────────────────────────

    get_vault_prefs: tool({
      description:
        "Get the user's Velvet vault preferences — which vaults they've manually added to their dashboard and which they've hidden. " +
        "Returns two lists: 'added' (manually pinned vaults) and 'hidden' (vaults removed from view). " +
        "Call when you need to know which vaults the user has customized their view for.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/velvet/vault-prefs`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    set_vault_pref: tool({
      description:
        "Pin or hide a Velvet vault on the user's dashboard. " +
        "status='added' pins the vault so it always appears; status='hidden' removes it from view. " +
        "Call when user says 'add this vault to my dashboard', 'hide this vault', or 'I want to track this vault'.",
      inputSchema: z.object({
        portfolioAddress: z.string().describe("The Velvet vault/portfolio contract address"),
        status: z.enum(["added", "hidden"]).describe("'added' to pin, 'hidden' to remove from view"),
      }),
      execute: async ({ portfolioAddress, status }) => {
        try {
          const r = await fetch(`${appBase()}/api/velvet/vault-prefs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ portfolioAddress, status }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    remove_vault_pref: tool({
      description:
        "Remove a vault preference entirely — resets the vault to its default display state (neither pinned nor hidden). " +
        "Call when user says 'reset my preference for this vault' or 'stop tracking/hiding this vault'.",
      inputSchema: z.object({
        portfolioAddress: z.string().describe("The Velvet vault/portfolio contract address to reset"),
      }),
      execute: async ({ portfolioAddress }) => {
        try {
          const r = await fetch(`${appBase()}/api/velvet/vault-prefs?portfolio=${encodeURIComponent(portfolioAddress)}`, {
            method: "DELETE",
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Banking Collection & Ledger ──────────────────────────────────────────

    initiate_banking_collection: tool({
      description:
        "Initiate a collection (payment link / virtual account request) from a customer via the banking provider. " +
        "Creates a virtual account or payment link the customer pays into. " +
        "Call when user wants to 'collect money from a customer', 'create a payment request', or 'receive a payment via banking'.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        amount: z.number().positive().describe("Amount to collect in the provider's base currency"),
        description: z.string().optional().describe("Description of the collection"),
        customerRef: z.string().optional().describe("Your reference for the customer"),
      }),
      execute: async ({ provider, amount, description, customerRef }) => {
        try {
          const r = await fetch(`${appBase()}/api/banking/${provider}/collect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount, description, customerRef }),
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_banking_collections: tool({
      description:
        "List or look up banking collections (inbound payments received via virtual accounts or payment links). " +
        "Call when user asks 'did my customer pay?', 'show received payments', or wants to check collection status.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        id: z.string().optional().describe("Specific transaction/collection ID to look up"),
      }),
      execute: async ({ provider, id }) => {
        try {
          const params = new URLSearchParams();
          if (id) params.set("id", id);
          const r = await fetch(`${appBase()}/api/banking/${provider}/collections?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    get_banking_wallet_ledger: tool({
      description:
        "Get the main banking wallet ledger — full transaction history of the banking wallet (credits, debits, transfers). " +
        "Different from the payout wallet ledger (get_payout_wallet_ledger). " +
        "Call when user asks 'show my banking wallet history' or wants to reconcile the main banking wallet.",
      inputSchema: z.object({
        provider: z.string().describe("Provider ID, e.g. 'credible'"),
        page: z.number().optional().describe("Page number, starts at 1"),
        limit: z.number().optional().describe("Results per page, default 20"),
      }),
      execute: async ({ provider, page, limit }) => {
        try {
          const params = new URLSearchParams();
          if (page !== undefined) params.set("page", String(page));
          if (limit !== undefined) params.set("limit", String(limit));
          const r = await fetch(`${appBase()}/api/banking/${provider}/ledger?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Goals ────────────────────────────────────────────────────────────────

    get_goals: tool({
      description:
        "Fetch all of the user's savings goals linked to their Velvet Capital vaults. " +
        "Each goal has a name, target amount, currency, and the vault it belongs to. " +
        "Call when user asks 'what are my savings goals?', 'show my goals', or 'am I on track?'.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const r = await fetch(`${appBase()}/api/goals`);
          if (!r.ok) return { error: await r.text() };
          const data = await r.json();
          // Return as a plain array so the UI goals card renders correctly
          return Array.isArray(data?.goals) ? data.goals : data;
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    create_goal: tool({
      description:
        "Create or update a savings goal for a Velvet Capital vault. " +
        "Associates a target amount and name with a vault so the user can track progress. " +
        "Call when user says 'set a goal of $5000 for my vault' or 'I want to save 10 ETH in this vault'.",
      inputSchema: z.object({
        vaultId: z.string().describe("Velvet vault address or ID the goal is linked to"),
        name: z.string().describe("Goal name, e.g. 'Emergency Fund', 'Buy a car'"),
        targetAmount: z.string().describe("Target amount as a string, e.g. '5000'"),
        currency: z.string().describe("Currency code, e.g. 'USDC', 'ETH'"),
      }),
      execute: async ({ vaultId, name, targetAmount, currency }) => {
        try {
          const r = await fetch(`${appBase()}/api/goals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vaultId, name, targetAmount, currency }),
          });
          if (!r.ok) return { error: await r.text() };
          const data = await r.json();
          // Shape the response so the UI goal card renders correctly:
          // card expects: { success: true, goal: { name, targetAmount, currency, friendlyVault } }
          const goal = data?.goal ?? data;
          return {
            success: true,
            goal: {
              ...goal,
              name: goal.name ?? name,
              targetAmount: goal.targetAmount ?? targetAmount,
              currency: goal.currency ?? currency,
              friendlyVault: goal.vaultId
                ? `${String(goal.vaultId).slice(0, 6)}…${String(goal.vaultId).slice(-4)}`
                : vaultId
                  ? `${vaultId.slice(0, 6)}…${vaultId.slice(-4)}`
                  : "vault",
            },
          };
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    delete_goal: tool({
      description:
        "Delete a savings goal linked to a Velvet vault. " +
        "Call when user says 'remove my goal for this vault' or 'I no longer want to track this savings goal'. " +
        "Confirm with the user before deleting.",
      inputSchema: z.object({
        vaultId: z.string().describe("Velvet vault address or ID whose goal to delete"),
      }),
      execute: async ({ vaultId }) => {
        try {
          const r = await fetch(`${appBase()}/api/goals?vaultId=${encodeURIComponent(vaultId)}`, {
            method: "DELETE",
          });
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

    // ─── Activity ─────────────────────────────────────────────────────────────

    get_activities: tool({
      description:
        "Fetch the user's recent DeFi activity log — Velvet vault deposits, withdrawals, swaps, and swap-and-deposits. " +
        "Each record includes type, amount, token, vault, txHash, and timestamp. " +
        "Call when user asks 'what have I done recently?', 'show my transaction history', or 'what was my last deposit?'.",
      inputSchema: z.object({
        limit: z.number().optional().describe("Number of activities to return, max 100, default 20"),
      }),
      execute: async ({ limit }) => {
        try {
          const params = new URLSearchParams();
          if (limit !== undefined) params.set("limit", String(limit));
          const r = await fetch(`${appBase()}/api/activity?${params}`);
          if (!r.ok) return { error: await r.text() };
          return await r.json();
        } catch (err: any) { return { error: err?.message ?? "Failed" }; }
      },
    }),

  };
}
