# Bluvfi

**An AI money assistant for people and businesses: pay bills, buy gift cards and top-ups, invest, and run a business treasury on Arc. Do it on screen or by asking the agent.**

- Live app: https://bluvfi.xyz
- Android app: built from this repo with Capacitor (see [Android](#android-app))

Bluvfi holds a user's stablecoins in a Privy embedded wallet and lets them spend those stablecoins on real things: gift cards, phone top-ups, eSIMs, domains, US stocks, private-market deals and GPU compute. Money can arrive from Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Arc, Solana, XRP, Zcash, Hyperliquid, Tempo and Robinhood Chain. The chat agent can do almost everything the screens can. Nothing that moves a user's money happens until the user taps Confirm on a card.

**Bluvfi for Business** adds a treasury agent. Each business gets its own USDC treasury on Arc, held in a Circle developer-controlled wallet. The agent pays vendors and contractors within limits the owner sets, and it signs every decision into a hash-chained log that anyone can verify.

---

## Contents

- [Bluvfi for Business: a treasury agent on Arc](#bluvfi-for-business-a-treasury-agent-on-arc)
- [What's in the app](#whats-in-the-app)
- [The AI agent](#the-ai-agent)
- [Payments, chains and wallets](#payments-chains-and-wallets)
- [Circle products used](#circle-products-used)
- [Shar rewards and the open provider network](#shar-rewards-and-the-open-provider-network)
- [Platform](#platform)
- [Live market data (CoinMarketCap)](#live-market-data-coinmarketcap)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Database](#database)
- [Getting started](#getting-started)
- [Tests](#tests)
- [Deployment](#deployment)
- [Hackathons](#hackathons)

---

## Bluvfi for Business: a treasury agent on Arc

A business owner opens the **Business** tab, creates a business, adds payees, and files bills. They can also paste an invoice, and the agent reads it. From then on the agent decides on each bill whether to pay it now, defer it or escalate it to the owner. It pays in USDC on Arc, which is also Arc's gas token, so the treasury never needs a second token.

| Piece | What it does | Files |
|-------|--------------|-------|
| Treasury on Arc | One Arc mainnet wallet per business (up to 5 per user). The balance is read on-chain. $0.05 is always kept back for gas. | [`src/lib/business/treasury.ts`](src/lib/business/treasury.ts) |
| Custody | **Circle developer-controlled wallets** when `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` are set: one wallet set per business and one EOA on `ARC`. Payments use `createTransaction` with an idempotency key, and log entries are signed with `signMessage`. Without Circle keys, Bluvfi generates a key and stores it encrypted (AES-256-GCM, bound to the business). | `treasury.ts`, [`scripts/circle-setup.mjs`](scripts/circle-setup.mjs) |
| Payees | A name, a type (vendor or contractor), an address, an optional per-payee cap and an allowlist switch. | [`src/lib/business/service.ts`](src/lib/business/service.ts) |
| Bills and invoices | Bills have a due date and an invoice reference. The same invoice number can't be filed twice for one payee. A pasted invoice is read by the LLM into a bill. If the invoice's pay-to address doesn't match the payee on file, it isn't filed, and an escalation is logged instead. | `service.ts` |
| Policy | Defaults: `dailyCapUsd 200`, `perPaymentCapUsd 100`, `approvalAboveUsd 50`, `reserveUsd 1`, `payWithinDays 2`, `autopay true`. The owner can change them. | [`src/lib/business/policy.ts`](src/lib/business/policy.ts) |
| Agent run | See the steps below. | [`src/lib/business/agent.ts`](src/lib/business/agent.ts) |
| Owner approval | Approving an escalated bill lets the next run pay it, even over the approval threshold. A payee that isn't allowlisted still blocks payment. | `service.ts` |
| Signed decision log | Every action is written to an append-only log: created, payee added, bill added, run, pay, defer, escalate, blocked, approve, cancel, withdraw, policy change, failed, visibility. The treasury key signs each entry's SHA-256 hash, and each hash includes the previous one. | [`src/lib/business/ledger.ts`](src/lib/business/ledger.ts) |
| Verification | `verifyDecisionLog` checks for sequence gaps, the hash links, every hash and every signature against the treasury address. The owner can run it with a **Verify** button. | `ledger.ts` |
| Public audit page | When the owner makes the log public, `/audit/<businessId>` shows it and verifies it live on every load. `GET /api/business/<id>/log` returns the same data as JSON. | [`src/app/audit/[id]/page.tsx`](src/app/audit/[id]/page.tsx), [`src/app/api/business/[id]/log/route.ts`](src/app/api/business/[id]/log/route.ts) |
| Scheduled runs | A GitHub Actions workflow calls `POST /api/business/cron` every hour at :07 with a shared secret. Each call runs the agent for up to 25 businesses that have a bill due in the next 30 days. | [`.github/workflows/business-cron.yml`](.github/workflows/business-cron.yml), [`src/app/api/business/cron/route.ts`](src/app/api/business/cron/route.ts) |
| Withdraw | Only to the owner's own Bluvfi wallet. It's available in the Business tab only; the chat agent can't withdraw. | `treasury.ts` |
| Chat | 12 `business_*` tools: overview, create, add payee, add bill, file invoice, run agent, approve, cancel, allowlist, public log, set policy and read the decision log. | [`src/lib/ai/business-tools.ts`](src/lib/ai/business-tools.ts) |
| Screen | Treasury balance, bills by status, payees, a limits editor, invoice paste, Run agent, approve, verify, the public-log switch and the audit link. | [`src/components/business/business-screen.tsx`](src/components/business/business-screen.tsx) |

**How a run decides** (`runTreasuryAgent`):

1. It first finishes any payments still in flight. A bill stuck in `paying` with no transaction is reset after 120 s and keeps its idempotency key.
2. It takes the bills due within `payWithinDays`, soonest first.
3. It checks hard rules on each bill:
   - the payee is allowlisted;
   - the payee cap and the per-payment cap (both waived once the owner approves);
   - the 24-hour daily cap;
   - funds left after the reserve and gas;
   - a duplicate check: the same payee and amount paid in the last 30 days under a different invoice number.
4. The model (the same provider chain as chat, with a 12 s budget) picks `pay_now`, `defer` or `escalate` for each bill and gives a short reason. With no model available, the rules decide on their own.
5. The code enforces the rules, whatever the model says. A "pay" that breaks a rule, or that needs approval (above `approvalAboveUsd`, or when autopay is off), is overruled and logged as `blocked`.
6. Before paying, it re-checks the live balance and the cap. It then claims the bill atomically, sends with an idempotency key, waits up to 10 s for Arc to confirm, and records the payment in History.
7. Repeated runs don't fill the log: a decision is logged again only when the action or the set of failing rules changes.

---

## What's in the app

The dashboard ([`src/app/app/page.tsx`](src/app/app/page.tsx)) has tabs for Bills, Invest, Business, History and Banking, plus a wallet card and the chat sheet.

### Bills

| Provider | What users can buy | How they pay | Status |
|----------|-------------------|--------------|--------|
| **Bitrefill** | Gift cards, phone top-ups and eSIM data in 32 countries, with no Bitrefill account (the code is delivered by email) | From the wallet: USDC/USDT on Base, Ethereum, Polygon, Arbitrum and Optimism; USDT on BSC; Solana USDC/USDT. To a deposit address: BTC, Lightning, ETH, SOL, TON, SUI, BNB, LTC, DOGE, Tron USDT and more. Routed through Bluvfi: XRP, Zcash, Hyperliquid USDC, Arc USDC, Tempo USDC.e and Robinhood Chain ETH. Link checkout: Binance Pay and Kraken Pay. | Live. Orders are confirmed server-side, so chain-paid purchases don't stay pending. |
| **Cryptorefills** | Gift cards, top-ups and eSIMs | Gasless USDC over x402: an EIP-3009 signature on Base, or Solana. "Other chain" first tops up the Base wallet from Arc, Tempo, Robinhood, XRP, Zcash or Hyperliquid. "Other crypto" (about 25 coins via a deposit address) needs `CRYPTOREFILLS_PARTNER_ID`. | Live, no API key needed |

Files: [`src/components/dashboard/bills-screen.tsx`](src/components/dashboard/bills-screen.tsx), [`src/lib/bitrefill.ts`](src/lib/bitrefill.ts), [`src/lib/cryptorefills.ts`](src/lib/cryptorefills.ts), `src/app/api/bitrefill/*`, `src/app/api/cryptorefills/*`.

### Invest

| Provider | What users can do | Status |
|----------|-------------------|--------|
| **US stocks and ETFs (Backpack)** | Buy and sell fractional shares. Bluvfi trades from one Backpack account and keeps a ledger per user. Money comes in as USDC on Base, or as a top-up from any of the six routed chains, and goes out as USDC on Base. | Prices and charts always work. Trading needs `BACKPACK_API_KEY` and `BACKPACK_API_SECRET`. |
| **GetEquity** | Pre-IPO and private-market deals through a KYC'd member account, funded by card link or bank transfer | Needs `GETEQUITY_SECRET_KEY`. Uses the sandbox unless `GETEQUITY_ENV=live`. |
| **Nosana GPU** | Deploy, start, stop and archive Docker workloads on Nosana GPU markets, billed to Bluvfi's NOS credits | Needs `NOSANA_API_KEY` |
| **Doma domains** | Search, register and renew domains (paid in USDC.e or ETH on the Doma chain), and buy listed domains on Doma or Base. The section also shows the market, orderbook and events. | Live on mainnet |
| xStocks | Tokenized stock data: assets, oracles and proof of reserves; RFQ | Hidden in the UI; available through the agent |
| Oro GRAIL gold | Buy, sell and redeem gold on Solana | Hidden in the UI; available through the agent. Needs the `GRAIL_*` keys. |

Files: [`src/components/dashboard/investments-screen.tsx`](src/components/dashboard/investments-screen.tsx) and the `*-section.tsx` files next to it, [`src/lib/stocks.ts`](src/lib/stocks.ts), [`src/lib/backpack.ts`](src/lib/backpack.ts), [`src/lib/getequity.ts`](src/lib/getequity.ts), [`src/lib/nosana.ts`](src/lib/nosana.ts), [`src/lib/doma.ts`](src/lib/doma.ts).

### Wallet

The fund-wallet sheet ([`src/components/dashboard/fund-wallet-sheet.tsx`](src/components/dashboard/fund-wallet-sheet.tsx)) has six tabs:

- **Buy:** a card on-ramp through Privy to Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche or Solana.
- **Balances:** one view of wallet USDC across chains (Circle App Kit Unified Balance) plus the Circle Gateway balance.
- **Send:** sends USDC from the wallet with Circle App Kit.
- **Bridge:** moves USDC from Ethereum, Arbitrum, Optimism, Avalanche, Polygon, Linea, Base or Arc (and Solana, when enabled) to Base or Arc with Circle App Kit Bridge (CCTP). Transfers to Arc use Circle's forwarder, so the user needs no Arc gas to receive.
- **Arc:** the live Arc USDC balance, an explorer link, and sending on Arc.
- **Solana:** the Solana receive address.

The **chain top-up** panel ([`src/components/dashboard/chain-topup-panel.tsx`](src/components/dashboard/chain-topup-panel.tsx)) brings money in from chains Circle doesn't cover yet, as USDC or ETH on Base: Arc, Tempo, Robinhood Chain, XRP, Zcash (transparent addresses) and Hyperliquid. Every swap is tracked, and a failed XRP swap can be recovered to the user's XRP wallet.

The **settings sidebar** shows the user's EVM, Solana and XRP wallets with their balances, and has Premium and sign-out.

### History

Every payment is stored in Postgres and listed in the History tab with its chain and transaction hash. That includes bills, investments, domains, business payments, transfers, bridges, nanopayments, x402 payments, deposits, withdrawals, and on-ramp and off-ramp orders ([`src/components/dashboard/payments-screen.tsx`](src/components/dashboard/payments-screen.tsx), [`src/app/api/payments/route.ts`](src/app/api/payments/route.ts)).

### Banking

The tab shows "Coming soon". The integrations behind it exist and are reachable from the agent on the web, gated by their keys:

- Credible Finance: INR collections, on-ramp, off-ramp, payouts and sub-accounts.
- SpherePay: customers, transfers, virtual accounts and KYC.
- Fuze: users, wallets, trades and remittance; uses Fuze's preprod host by default.
- Ripple ODL: a stub that hasn't been live-tested.

Files: [`src/lib/banking/`](src/lib/banking), [`src/lib/spherepay.ts`](src/lib/spherepay.ts), [`src/lib/fuze.ts`](src/lib/fuze.ts).

---

## The AI agent

| | |
|--|--|
| **Models** | OpenAI (`OPENAI_MODEL`, default `gpt-4o-mini`) or Qwen through DashScope (`AI_PROVIDER=qwen`). If both keys are set, the other provider is used as a fallback. The route reads the first chunk of the stream before answering, and moves to the next model if it's empty or an error. Source: [`src/lib/ai/model-provider.ts`](src/lib/ai/model-provider.ts), [`src/app/api/chat/route.ts`](src/app/api/chat/route.ts). |
| **Voice** | Voice messages are transcribed by Google Gemini ([`src/app/api/voice/transcribe/route.ts`](src/app/api/voice/transcribe/route.ts)). |
| **Insights** | Gemini writes a weekly spending summary from payments and balance snapshots ([`src/lib/gemini.ts`](src/lib/gemini.ts), `/api/insights/weekly`). |
| **Context** | The system prompt gets the user's live balances, XRP wallet, upcoming bills and client type (web or Android) ([`src/lib/ai/system-prompt.ts`](src/lib/ai/system-prompt.ts)). Chat history is windowed to the last 20 messages, plus a recap of earlier actions ([`src/lib/ai/window-messages.ts`](src/lib/ai/window-messages.ts)). |
| **Confirmation** | Tools that spend the user's money don't send anything themselves. They return a pending payload, and the chat renders a card for it: Bitrefill, Cryptorefills, GetEquity, Doma registration, Doma listing, chain top-up, Arc send, stock trade or asset buy. The user's wallet pays only when they tap Confirm. The card then reports the result back to the agent ([`src/components/chat/`](src/components/chat)). |
| **Limits** | Free: 20 messages/min, 200/day, 1M tokens/day and 500 tool calls/day. Premium (RevenueCat): 30/min, 2,000/day, 10M tokens and 5,000 tool calls. Rewarded ads add bonus messages ([`src/lib/user-rate-limiter.ts`](src/lib/user-rate-limiter.ts)). |
| **Android allowlist** | The Android app gets a reduced tool set. Operator, banking, agent-wallet and payout tools are left out ([`src/lib/ai/app-tools.ts`](src/lib/ai/app-tools.ts)). |

**Tools, by area** ([`src/lib/ai/tools.ts`](src/lib/ai/tools.ts) and the `*-tools.ts` files next to it):

| Area | Tools |
|------|-------|
| Business treasury | `business_overview`, `business_create`, `business_add_payee`, `business_add_bill`, `business_file_invoice`, `business_run_agent`, `business_approve_bill`, `business_cancel_bill`, `business_set_payee_allowlisted`, `business_set_public_log`, `business_set_policy`, `business_decision_log` |
| Market data | `get_crypto_prices`, `get_crypto_market_overview`, `get_top_movers`, `get_trending_crypto`, `convert_crypto` |
| Bitrefill | `get_bills`, `get_product_details`, `buy_bitrefill_product`, `poll_bitrefill_order`, `get_bitrefill_orders` |
| Cryptorefills | `search_cryptorefills`, `get_cryptorefills_products`, `get_cryptorefills_payment_methods`, `buy_cryptorefills_product`, `get_cryptorefills_order`, `get_cryptorefills_orders` |
| Stocks | `search_stocks`, `get_stock`, `get_stock_portfolio`, `trade_stock`, `withdraw_stock_credit` |
| Arc and other chains | `get_arc_balance`, `send_usdc_arc`, `get_other_chain_balances`, `fund_wallet_from_chain`, `get_chain_payments`, `fund_xrp_topup_from_wallet` |
| XRP | `get_xrp_wallet`, `get_xrp_balance`, `get_xrp_activity`, `get_xrp_payment_status`, `fund_xrp_purchase_from_wallet`, `list_recoverable_xrp`, `recover_xrp_order` |
| Wallet and history | `open_fund_wallet`, `get_payment_history`, `get_balance_history` |
| Providers | `doma_*` (41), `getequity_*` (22), `nosana_*` (10), `xstocks_*` (35), `grail_*` (15) |
| Agent wallet (web) | `x402_pay`, `get_nanopay_balance` and `nanopay_*` (Circle Gateway: deposit, pay, transfer, withdraw), `get_solpay_balance` and `solpay_*`, `solana_transfer_usdc` |
| Banking (web) | Credible on-ramp, off-ramp, collections, sub-accounts and payouts; `spherepay_*`; `fuze_*` |
| Rewards (Android) | `get_my_shar`, `search_network_providers`, `get_my_network_account`, `get_provider_details`, `get_my_activity` |

---

## Payments, chains and wallets

**One EVM payment path** ([`src/lib/evm-pay.ts`](src/lib/evm-pay.ts)). Each payment tries three ways in order:

1. a gas-sponsored transaction through Privy, on Ethereum, Base, Polygon, Arbitrum and Optimism;
2. the user's own wallet paying gas (in USDC on Arc);
3. Circle App Kit Send.

The wallet's chain is checked before a user-gas send.

| Chain | How Bluvfi uses it | Files |
|-------|-------------------|-------|
| **Arc** (5042) | USDC balance, sending, bridging in, paying Bitrefill, Cryptorefills, stocks and Doma, and the business treasuries. Browser RPC goes through `/api/rpc/arc`, so blockers can't break the wallet. Bluvfi signs Arc transfers in the wallet and broadcasts them through that proxy itself. | [`src/lib/arc-chain.ts`](src/lib/arc-chain.ts), [`src/app/api/rpc/arc/route.ts`](src/app/api/rpc/arc/route.ts) |
| **Base** (8453) | The default USDC chain, and where the chain top-ups deliver | [`src/lib/arc-kit.ts`](src/lib/arc-kit.ts) |
| Ethereum, Arbitrum, Optimism, Polygon, Avalanche, BSC | Bridging in, the unified balance and Bitrefill payments | `fund-wallet-sheet.tsx` |
| **Solana** | Privy Solana wallet: Bitrefill and Cryptorefills payments, credit top-ups, and agent-wallet nanopayments | [`src/lib/solana-pay-kit.ts`](src/lib/solana-pay-kit.ts) |
| **XRP Ledger** | Each user gets a Bluvfi XRP wallet. XRP pays Bitrefill directly and tops up the Base wallet for every other provider, and a failed swap can be recovered. Runs through Bluvfi's own XRPL service. | [`src/lib/xrplBackend.ts`](src/lib/xrplBackend.ts), [`src/lib/xrp-purchase.ts`](src/lib/xrp-purchase.ts), [`src/app/api/xrpl/`](src/app/api/xrpl) |
| Tempo, Robinhood Chain, Zcash, Hyperliquid | Chain top-ups to Base: LI.FI routes for Arc and Tempo, NEAR Intents for Robinhood Chain, and deposit addresses for XRP, Zcash and Hyperliquid. Every swap is a row in `chain_swaps`. | [`src/lib/swap-chains.ts`](src/lib/swap-chains.ts), [`src/lib/chain-topup.ts`](src/lib/chain-topup.ts), [`src/lib/chain-swaps.ts`](src/lib/chain-swaps.ts) |
| Doma (97477) | Domain registration and listings | [`src/lib/doma-chain.ts`](src/lib/doma-chain.ts) |

**x402.** Bluvfi works with x402 in three roles:

- **Buyer:** the agent wallet pays outside x402 offers ([`src/lib/x402-consumer.ts`](src/lib/x402-consumer.ts)).
- **Seller:** outside agents pay per call for providers on Bluvfi's network ([`src/lib/x402-edge.ts`](src/lib/x402-edge.ts)).
- **Checkout:** Cryptorefills checkout runs over x402.

---

## Circle products used

| Product | Where | What for |
|---------|-------|----------|
| **Arc** | Throughout | User USDC balances and payments, and business treasuries |
| **Developer-controlled wallets** (`@circle-fin/developer-controlled-wallets`) | [`src/lib/business/treasury.ts`](src/lib/business/treasury.ts) | One wallet per business treasury on Arc: idempotent payments, and signatures on the decision log |
| **App Kit Send** (`@circle-fin/app-kit`, Viem and Solana adapters) | `fund-wallet-sheet.tsx`, `evm-pay.ts` | Sending USDC, and step 3 of the payment path |
| **App Kit Bridge (CCTP)** with the forwarder | `fund-wallet-sheet.tsx` | Bridging USDC from 8 EVM chains (and Solana, when enabled) to Base or Arc; no Arc gas needed to receive |
| **App Kit Unified Balance** | [`src/hooks/use-unified-balance.ts`](src/hooks/use-unified-balance.ts) | One USDC balance across Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche, Arc and Solana |
| **Gateway nanopayments / x402 batching** (`@circle-fin/x402-batching`) | [`src/lib/circle-gateway.ts`](src/lib/circle-gateway.ts), `src/app/api/nanopay/*` | The agent wallet's Gateway balance: deposit, pay x402 URLs, transfer and withdraw; plus an x402 seller endpoint |
| **USDC** | Everywhere | The unit of account and the gas on Arc |

These aren't used yet: App Kit Swap, Circle Paymaster (the gas sponsorship is Privy's), USYC and EURC.

---

## Shar rewards and the open provider network

This is the backend for the rewards and network screens in the Bluvfi Android app. The web dashboard here doesn't render those screens.

- **Shar** ([`src/lib/shar.ts`](src/lib/shar.ts))
  - Users earn 1 Shar per $1 on completed purchases of $10 or more. Referrers earn 10%, and provider owners earn when others use their listings.
  - Shar is claimed as SKR at 0.9 SKR per Shar. The team reviews every payout.
- **Daily Spark** ([`src/lib/shar-spark-rules.ts`](src/lib/shar-spark-rules.ts))
  - One collect per UTC day, with a streak multiplier and a bonus every 7th day.
  - Seeker Genesis Token holders get a boost, checked on-chain ([`src/lib/seeker-sgt.ts`](src/lib/seeker-sgt.ts)).
- **Squads:** up to 10 members working toward a weekly pooled goal ([`src/lib/shar-squads.ts`](src/lib/shar-squads.ts)).
- **Weekly prizes and leaderboard:** 50, 30 and 20 Shar to the week's top three, from the week of Oct 12, 2026. The leaderboard uses anonymous handles.
- **Referrals:** `/r/<code>` pages open the app. The bonus counts only spending made after the code is attached, and never between linked accounts ([`src/app/r/[code]/page.tsx`](src/app/r/[code]/page.tsx)).
- **Open provider network** ([`src/lib/provider-network.ts`](src/lib/provider-network.ts))
  - Creators list API providers, and the team verifies each one. Owners can edit, pause or remove their listings, and set their own versioned terms.
  - Credentials are encrypted and never shown again after saving.
  - Provider URLs are checked: HTTPS only, public host, DNS pinned, no redirects.
- **Credits and earnings** ([`src/lib/credits.ts`](src/lib/credits.ts), [`src/lib/earnings.ts`](src/lib/earnings.ts))
  - Prepaid USDC credits, topped up with Solana USDC and checked on-chain. The ledger is append-only and the balance never goes negative.
  - Owners get 80% of each paid call, paid out as SKR.
- **SKR payouts** ([`src/lib/skr-payout.ts`](src/lib/skr-payout.ts))
  - An admin approves every payout.
  - The signature is saved before broadcast, so a payout is never sent twice.
  - There are single-payout and 24-hour caps.

---

## Platform

| Feature | What it does | Files |
|---------|--------------|-------|
| Sign-in | Privy email and passkey login, with embedded EVM and Solana wallets | [`src/lib/privy.ts`](src/lib/privy.ts), [`src/lib/auth.ts`](src/lib/auth.ts) |
| Notifications | No push service. The server leaves short messages in an inbox, and the phone polls it with its own secret key, of which only a hash is stored. Messages never contain amounts or addresses. | [`src/lib/inbox.ts`](src/lib/inbox.ts) |
| Abuse controls | Accounts that share a device or payout wallet are linked, and linked accounts can't earn from each other. Claims are limited per device. | [`src/lib/abuse.ts`](src/lib/abuse.ts) |
| Rate limits | Per-user limits in Postgres (in memory if the database is down), plus per-IP limits and security headers (CSP, HSTS) in middleware | [`src/lib/rate-limit-store.ts`](src/lib/rate-limit-store.ts), [`src/middleware.ts`](src/middleware.ts) |
| Admin | Review queue for listings and payouts. Admins come from `NETWORK_ADMIN_USER_IDS`, and every action is audited. | [`src/lib/admin.ts`](src/lib/admin.ts), `src/app/api/admin/*` |
| Premium | RevenueCat subscriptions and a paywall sheet on Android | [`src/lib/revenuecat.ts`](src/lib/revenuecat.ts), [`src/components/paywall/paywall-sheet.tsx`](src/components/paywall/paywall-sheet.tsx) |
| Rewarded ads | AdMob, verified by Google's signed server-side callback, grants bonus chat messages | [`src/lib/admob-ssv.ts`](src/lib/admob-ssv.ts) |
| PWA | Installable, with an offline page (Serwist) | [`src/app/sw.ts`](src/app/sw.ts) |
| Landing and onboarding | Landing page on the web; onboarding slides and sign-in in the Android app | [`src/components/landing/`](src/components/landing), [`src/components/onboarding/onboarding-screen.tsx`](src/components/onboarding/onboarding-screen.tsx) |

### Android app

- **What it is:** Capacitor 8 (`com.bluvfi.xyz`). It loads a static export of this app and calls the deployed API.
- **Build:** `yarn build:android` hides the API routes and the server-only pages (`/r/[code]` and `/audit/[id]`) while it exports, then restores them ([`scripts/build-android.mjs`](scripts/build-android.mjs)).
- **API calls:** [`src/components/capacitor-fetch-patch.tsx`](src/components/capacitor-fetch-patch.tsx) points relative `/api` calls at `NEXT_PUBLIC_API_URL`.
- **Solana RPC:** goes through `/api/solana/rpc`, so no RPC key ships in the APK.

---

## Live market data (CoinMarketCap)

*Submitted to [Build with CMC: API Hackathon](https://dorahacks.io/hackathon/coinmarketcap-api-202609/detail), track **AI Agents and Automation**. The whole CoinMarketCap integration was built during that event (first commit `fdbe2d8`, 2026-09-21).*

- Demo video: https://x.com/bluvfi/status/2097352616275517776
- X post: https://x.com/Jwafo_tweet/status/2104919554572853710
- Write-up with a real request and response: [docs/cmc-hackathon-submission.md](docs/cmc-hackathon-submission.md)

The dashboard has a live price ticker, and the agent has five tools for questions like "what's XRP doing today", "what are the top gainers right now" or "what's 250 XRP worth in NGN".

### Endpoints used

| Endpoint | Used for | Files |
|----------|----------|-------|
| `GET /v1/cryptocurrency/quotes/latest` | Dashboard price ticker (BTC/ETH/SOL/XRP, by CMC id) | [`src/lib/coinmarketcap.ts`](src/lib/coinmarketcap.ts) |
| `GET /v3/cryptocurrency/quotes/latest` | `get_crypto_prices` | [`src/lib/ai/cmc-tools.ts`](src/lib/ai/cmc-tools.ts) |
| `GET /v3/cryptocurrency/listings/latest` | `get_top_movers` and `get_crypto_market_overview` | [`src/lib/ai/cmc-tools.ts`](src/lib/ai/cmc-tools.ts) |
| `GET /v1/global-metrics/quotes/latest` | `get_crypto_market_overview` | [`src/lib/ai/cmc-tools.ts`](src/lib/ai/cmc-tools.ts) |
| `GET /v1/cryptocurrency/trending/latest` | `get_trending_crypto` | [`src/lib/ai/cmc-tools.ts`](src/lib/ai/cmc-tools.ts) |
| `GET /v2/tools/price-conversion` | `convert_crypto` | [`src/lib/ai/cmc-tools.ts`](src/lib/ai/cmc-tools.ts) |

### Architecture

- **[`src/lib/coinmarketcap.ts`](src/lib/coinmarketcap.ts):** the only file that talks to CMC.
  - The key goes in the `X-CMC_PRO_API_KEY` header, never a query parameter.
  - Every call has an 8 s timeout, and errors are normalized, including the "200 OK with an error body" case.
  - A server cache (60 s by default, 15 s minimum, set with `COINMARKETCAP_CACHE_TTL_SECONDS`) merges identical in-flight requests. Errors are never cached.
- **[`src/lib/coinmarketcap-parse.ts`](src/lib/coinmarketcap-parse.ts):** pure parsers, tested against CMC's own docs examples. They handle the shape differences between endpoint versions and return an empty result instead of throwing.
- **[`src/lib/ai/cmc-tools.ts`](src/lib/ai/cmc-tools.ts):** the five agent tools. Every result carries `source: "CoinMarketCap"` and an `asOf` time, so the agent cites where each number came from.
- **[`src/app/api/prices/route.ts`](src/app/api/prices/route.ts):** an authenticated, rate-limited route that the dashboard ticker polls every 30 s ([`src/components/dashboard/price-ticker.tsx`](src/components/dashboard/price-ticker.tsx)). If a poll fails, the ticker shows the last prices marked as stale instead of going blank.

### Where the API got in the way

All of this was confirmed against the live API with a Startup-tier key on 2026-09-26. `npm run cmc:verify` reproduces items 1, 2 and 4.

1. **One ticker symbol matches many coins.** `quotes/latest?symbol=BTC` returned 13 coins, not in rank order. We pick the best-ranked coin for each symbol (`pickBestPerSymbol`).
2. **`market_cap_min` is applied after sort and limit.** "Top 5 gainers above $50M" returns 0 rows. We fetch the top 500 by market cap and rank them ourselves.
3. **`quote` comes in two shapes:** an array on the v3 endpoints, and an object keyed by currency on v1 and v2.
4. **`error_code` changes type:** a string `"0"` on v3, an integer `0` on v1 and v2.
5. **The docs example for `quotes/latest` doesn't match the live response.** The docs show a bare array; the live API returns `{ data, status }`.
6. **`price-conversion` returns every coin with the symbol**, with the canonical one first. We rely on that order, which isn't documented.

```bash
npm run test:cmc     # 20 offline tests
npm run cmc:verify   # real calls to all five endpoints (needs COINMARKETCAP_API_KEY); never prints the key
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16, React 19, TypeScript |
| Styling | Tailwind CSS 4, Framer Motion |
| AI | Vercel AI SDK 6 with OpenAI or Qwen (chat) and Google Gemini (voice, insights) |
| Auth and wallets | Privy (embedded EVM and Solana wallets), viem, wagmi 2 |
| Circle | `@circle-fin/app-kit`, `@circle-fin/adapter-viem-v2`, `@circle-fin/adapter-solana`, `@circle-fin/x402-batching`, `@circle-fin/developer-controlled-wallets` |
| Database | Neon Postgres, Drizzle ORM |
| Mobile | Capacitor 8 (Android), RevenueCat, AdMob |
| Hosting | AWS Amplify, with GitHub Actions for the hourly treasury run |

---

## Project structure

```
src/
├── app/
│   ├── page.tsx              # Landing page (web) / onboarding (Android)
│   ├── app/                  # The signed-in app: dashboard, tabs, chat sheet
│   ├── audit/[id]/           # Public treasury decision log (server-rendered)
│   ├── r/[code]/             # Referral landing page
│   └── api/                  # Route handlers: business, chat, bitrefill, cryptorefills, stocks,
│                             # doma, getequity, nosana, chain-topup, xrpl, rpc, nanopay, solpay,
│                             # x402, payments, shar, network, credits, admin, notifications…
├── components/
│   ├── business/             # Business tab
│   ├── chat/                 # Chat sheet and confirm cards
│   ├── dashboard/            # Bills, Invest, History, fund-wallet sheet, chain top-up
│   ├── landing/, onboarding/, paywall/
├── lib/
│   ├── business/             # Treasury, agent, policy, signed ledger, service
│   ├── ai/                   # Tools, system prompt, model provider, Android allowlist
│   ├── banking/              # Credible and Ripple ODL providers
│   ├── db/schema.ts          # Drizzle schema
│   └── …                     # One module per provider and chain
drizzle/                      # Hand-written SQL migrations
scripts/                      # Android build, migration helpers, Circle setup, tests
```

---

## Database

Neon Postgres with Drizzle ([`src/lib/db/schema.ts`](src/lib/db/schema.ts)). The SQL migrations in [`drizzle/`](drizzle) are written by hand. Every statement uses `IF NOT EXISTS`, so each file is safe to run twice.

| Migrations | Feature |
|-----------|---------|
| 0000–0003 | Payments, balance snapshots, Bitrefill orders, weekly insights, XRP wallets |
| 0004–0006 | GetEquity members, Nosana deployments, rate limits, stocks ledger |
| 0007–0015 | Shar, provider network, credits, earnings, payouts, x402 receipts, listing management, abuse controls, publishers, configs, terms, creators |
| 0016 | Chain swaps, Daily Sparks |
| 0017 | Bluvfi for Business (accounts, payees, bills, decisions), squads, weekly awards |
| 0018 | Notification inbox |
| 0019 | `chain_swaps.recovered_at` (XRP recovery) |

---

## Getting started

**Prerequisites:**

- Node.js 20+ and Yarn 1
- A [Privy](https://privy.io) app
- A [Neon](https://neon.tech) database
- An OpenAI or Qwen key

```bash
yarn install
cp .env.example .env      # fill in the values; every variable is documented in the file
```

Apply the SQL files in `drizzle/` in order, in the Neon SQL editor. Then run the helper scripts, which are also what Amplify runs on every build:

```bash
node --env-file=.env scripts/apply-stocks-migration.mjs
node --env-file=.env scripts/apply-chain-swaps-migration.mjs
node --env-file=.env scripts/apply-business-migration.mjs
```

For Circle-held business treasuries, create a Circle API key and run the one-time entity-secret setup on your own machine:

```bash
node --env-file=.env scripts/circle-setup.mjs
```

Start the app:

```bash
yarn dev                  # http://localhost:3000
```

**Key environment variables.** [`.env.example`](.env.example) lists every one, with instructions. Provider integrations stay off until their keys are set.

| Variable | For |
|----------|-----|
| `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Sign-in and wallets |
| `DATABASE_URL` | Postgres |
| `OPENAI_API_KEY` or `QWEN_API_KEY` (+ `AI_PROVIDER`) | Chat |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Voice and weekly insights |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Circle wallets for business treasuries |
| `PROVIDER_SECRET_KEY` | Encrypts stored keys (provider credentials, and local treasury keys) |
| `BUSINESS_CRON_SECRET` | Hourly treasury runs; set the same value in Amplify and as a GitHub Actions secret |
| `NEXT_PUBLIC_APP_URL` | The deployed site URL |
| `BLUVFI_XRPL_API_URL`, `BLUVFI_XRPL_API_KEY` | XRP and the routed chains |
| `BITREFILL_*`, `BACKPACK_*`, `GETEQUITY_*`, `NOSANA_API_KEY`, `DOMA_*`, `COINMARKETCAP_API_KEY` | The individual providers |

Server-only secrets are never prefixed with `NEXT_PUBLIC_`.

---

## Tests

```bash
yarn test        # 27 suites on an in-process Postgres (PGlite) built from the real migrations
yarn test:cmc    # CoinMarketCap parsers
```

The suites cover the business treasury, payments rules, Shar, sparks, squads, referrals and claims, the provider network, publishers, configs and terms, credits, top-ups, x402, SKR payouts, abuse controls, admin, AdMob verification, the notification inbox, the Solana RPC proxy, the Android tool allowlist and concurrency ([`scripts/tests/`](scripts/tests)).

---

## Deployment

- **Web:** AWS Amplify ([`amplify.yml`](amplify.yml)). The build fails without `PRIVY_APP_SECRET` and `DATABASE_URL`, and it runs the three migration helpers before `next build`.
- **Hourly treasury run:** [`.github/workflows/business-cron.yml`](.github/workflows/business-cron.yml). It's skipped, and stays green, until the `BUSINESS_CRON_SECRET` repository secret is set.
- **Android:** `yarn cap:sync` builds the static export and syncs it into `android/`. `yarn cap:open` opens Android Studio.

---

## Hackathons

### Tameion Agents Hackathon: Canteen × Circle (Sep 27 – Oct 17, 2026)

Built during the event: **Bluvfi for Business**, the treasury agent on Arc described [at the top](#bluvfi-for-business-a-treasury-agent-on-arc). It holds funds in Circle developer-controlled wallets, decides and pays bills within owner-set limits, keeps a signed and hash-chained decision log, verifies it publicly, and runs every hour. Also built during the event:

- USDC on Arc across the app: Arc tab, bridge to Arc, Arc payments, and an RPC proxy.
- New chains across all providers: Tempo, Robinhood Chain, Zcash, Hyperliquid and XRP.
- Shar rewards and squads, the open provider network, and the notification inbox.

All of this is the work since commit `a97f2b6` (2026-09-26), the last commit before the event.

RFBs addressed: **01 Intelligent Business Treasury**, **02 AP/AR Automation** (invoice reading, duplicate and address-mismatch checks), and **04 Autonomous Business Operator**. The audit trail follows the hackathon's "official who had to explain the books" idea: the agent writes a signed, append-only record of every decision.

### Arc Microgrants

USDC on Arc as a balance and payment rail. See [docs/arc-microgrant-submission.md](docs/arc-microgrant-submission.md).

### Lepton by Canteen

Circle App Kit Send and Bridge, and Circle Gateway x402 nanopayments.

### Build with CMC: API Hackathon

See [Live market data (CoinMarketCap)](#live-market-data-coinmarketcap).

---

## License

MIT
