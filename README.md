# Bluvfi — AI Financial Assistant

**Pay bills, subscribe to services, and invest — by chat or tap.**

Bluvfi is a mobile-first AI financial assistant that lets you manage recurring subscriptions, internet/cable bills, utilities, and investments (stocks, ETFs, pre-IPO) through natural conversation or a clean web2-style UI. Payments execute gaslessly from the user's embedded wallet via Circle Arc AppKit. Every payment — whether triggered by chat or by tapping a button — goes through the same on-chain path and is settled via Circle Gateway x402 nanopayments.

---

## How it works

1. **Sign up with email or social.** Privy creates an embedded EOA wallet — no seed phrases, no browser extension required.
2. **Browse bills and investments.** 16 pre-loaded bills (streaming, internet, cable, utility) and 10 assets (stocks, ETFs, pre-IPO) are shown in the UI.
3. **Pay manually or via the AI.**
   - **UI path:** Tap "Subscribe" on any bill or "Buy" on any asset → a payment modal opens → `arcKit.send()` transfers USDC gaslessly from your Privy wallet → bill flips to "Active ✓" / portfolio updates.
   - **AI path:** Type or say "Pay my Netflix" → the agent queues the payment and renders a Confirm card inline in the chat → tap Confirm → same `arcKit.send()` path executes → same state updates.
4. **Fund your wallet** when balance is low via the "Add Funds" sheet — Send from a browser wallet (Arc AppKit) or Bridge from 7 other mainnet networks (Arc AppKit Bridge → Base).
5. **Track history.** Every payment is recorded in the History tab and in Postgres.

---

## Features



- **AI agent** — Chat with OpenAI GPT-4o-mini via Vercel AI SDK. Agent can list bills, queue payments, queue investment purchases, check nanopay balance, deposit/withdraw from Circle Gateway, and pay x402-protected URLs.
- **Voice input** — OpenAI Whisper transcribes voice messages to text.
- **Gasless payments** — All bill and investment payments use `arcKit.send()` which sponsors gas via Circle's infrastructure. Users only need USDC — no ETH required.
- **Privy embedded wallet** — `useWallets()` from `@privy-io/react-auth` surfaces the user's embedded wallet directly to Arc AppKit via `createViemAdapterFromProvider`. No EIP-6963 browser wallet required for payments.
- **Arc AppKit Send** — Fund the agent wallet by sending USDC from any EIP-6963 browser wallet (MetaMask, Coinbase Wallet, etc.) on Base mainnet.
- **Arc AppKit Bridge** — Bridge USDC from 7 mainnet chains (Ethereum, Arbitrum, Optimism, Avalanche, Polygon, Linea, Base) into the agent wallet.
- **Circle Gateway x402 nanopayments** — Every payment triggers a real x402 round-trip against `/api/nanopay/sell`. The History tab shows ⚡ Nanopay when settlement succeeded.
- **Unified payment state** — `DemoStateProvider` lives at the layout level so chat confirm cards and dashboard screens share one React context. Payments from both UI and AI paths update the same state.
- **Dual persistence** — UI payments tracked in `localStorage` (`bluvfi_v1`). All payments (UI + AI chat) also written to Postgres `payments` table so the AI's `get_payment_history` tool reflects the full history.
- **Demo data** — 16 bills and 10 assets hardcoded in `src/lib/demo-data.ts`. Pre-loaded and feels like a real app.
- **Web2-friendly UX** — No crypto jargon. "Payment cancelled" not "transaction rejected". Receiver wallet never shown in the UI.
- **Time-aware greeting** — Dashboard and chat greet the user by first name with Good morning / afternoon / evening / night based on local time.
- **Low-balance alert** — Amber banner appears when USDC balance < $10, with a one-tap "Add Funds" button.
- **Portal-rendered modals** — All payment sheets and modals use `createPortal(modal, document.body)` to escape `overflow-y: auto` scroll containers. Z-index layering: chat input bar `z-[60]`, all modals `z-[70]`.
- **PWA** — Installable as a home screen app.

---

## Circle integrations

### Arc AppKit (`@circle-fin/app-kit`, `@circle-fin/adapter-viem-v2`)

| Feature | File | What it does |
|---------|------|-------------|
| Bill/investment payments | `src/components/dashboard/payment-modal.tsx` | Gasless USDC transfer from user's Privy wallet via `arcKit.send()` |
| Chat confirm — bills | `src/components/chat/pay-bill-confirm-card.tsx` | Same `arcKit.send()` path, triggered inline from the AI chat |
| Chat confirm — investments | `src/components/chat/buy-asset-confirm-card.tsx` | Same `arcKit.send()` path for investment purchases from chat |
| Fund wallet — Send | `src/components/dashboard/fund-wallet-sheet.tsx` | Send USDC from a browser wallet to the agent wallet |
| Fund wallet — Bridge | `src/components/dashboard/fund-wallet-sheet.tsx` | Bridge USDC from 8 source chains into the agent wallet |
| Config | `src/lib/arc-kit.ts` | `arcKit` singleton, `AGENT_CHAIN = Blockchain.Base`, 7 mainnet bridge source options |

**Payment call pattern (Privy embedded wallet):**
```ts
const privyWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
const provider = await privyWallet.getEthereumProvider();
const adapter = await createViemAdapterFromProvider({ provider: provider as any });
await arcKit.send({
  from: { adapter, chain: Blockchain.Base },
  to: RECEIVER,
  amount: amount.toFixed(6),
  token: "USDC",
});
```

**Bridge call pattern:**
```ts
await arcKit.bridge({
  from: { adapter, chain: BridgeChain.Ethereum },
  to: { adapter, chain: Blockchain.Base, recipientAddress: agentAddress },
  amount: "50.00",
  token: "USDC",
});
```

### Circle Gateway (`@circle-fin/x402-batching`)

| Feature | File | What it does |
|---------|------|-------------|
| Buyer client | `src/lib/circle-gateway.ts` | `GatewayClient` for the agent to make nanopayments |
| Facilitator client | `src/lib/circle-gateway.ts` | `BatchFacilitatorClient` to settle incoming payments |
| x402 seller endpoint | `src/app/api/nanopay/sell/route.ts` | Returns `402 + PAYMENT-REQUIRED` without signature; settles with signature |
| Checkout (post-payment) | `src/app/api/nanopay/checkout/route.ts` | Called after every UI payment confirms — runs full x402 round-trip against `/api/nanopay/sell` |
| Balance check | `src/app/api/nanopay/balance/route.ts` | Agent's Gateway spendable balance |
| Deposit | `src/app/api/nanopay/deposit/route.ts` | Top up Gateway balance from agent wallet |
| Pay | `src/app/api/nanopay/pay/route.ts` | Agent pays any x402-protected URL |
| Withdraw | `src/app/api/nanopay/withdraw/route.ts` | Pull Gateway balance back to agent wallet |

**x402 seller flow:**
1. `GET /api/nanopay/sell` without header → `402` + `PAYMENT-REQUIRED: <base64 requirements>`
2. `GatewayClient.pay(url)` reads the 402, signs, retries with `PAYMENT-SIGNATURE` header
3. Seller calls `facilitator.settle(payload, requirements)` → success

---

## AI agent tools

| Tool | Description |
|------|-------------|
| `get_bills` | Returns full catalog of 16 demo bills with amounts and due dates |
| `pay_bill` | Looks up bill, returns `{ pendingPayment: true, ... }` — UI renders a Confirm card; on tap, `arcKit.send()` executes and `markBillPaid` updates state |
| `get_investments` | Returns 10 demo assets (stocks, ETFs, pre-IPO) with prices and 24h change |
| `buy_investment` | Looks up asset, returns `{ pendingPurchase: true, ... }` — UI renders a Confirm card; on tap, `arcKit.send()` executes and `buyAsset` updates state |
| `get_market_prices` | Current prices filtered by type (stock / ipo / etf) or symbol |
| `get_payment_history` | Recent payments from Postgres `payments` table |
| `get_nanopay_balance` | Agent's Circle Gateway balance on Base mainnet |
| `nanopay_deposit` | Deposit USDC into Gateway for gas-free spending |
| `nanopay_pay` | Pay any x402-protected URL using Gateway |
| `nanopay_withdraw` | Withdraw unused Gateway balance back to wallet |

---


**Bills** (`src/lib/demo-data.ts`) — 16 pre-loaded:

| Category | Bills |
|----------|-------|
| Streaming | Netflix $15.49, Spotify $9.99, Max $15.99, Disney+ $7.99, Apple TV+ $9.99, Hulu $17.99, YouTube Premium $13.99, Amazon Prime $14.99 |
| Internet | Xfinity Internet $79.99, AT&T Fiber $65.00, Verizon Home Internet $69.99 |
| Cable | Xfinity TV $89.99, DirecTV $74.99 |
| Utility | Electric $120.00, Water & Sewer $45.00, Natural Gas $38.50 |

**Assets** (`src/lib/demo-data.ts`) — 10 pre-loaded:

| Type | Assets |
|------|--------|
| Stock | AAPL, TSLA, GOOGL, MSFT, NVDA, AMZN |
| Pre-IPO | SPACEX, OPENAI |
| ETF | SPY, QQQ |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15, React 19, TypeScript |
| Styling | Tailwind CSS v4 |
| AI | Vercel AI SDK v6, OpenAI GPT-4o-mini (chat), OpenAI Whisper (voice) |
| Auth | Privy (EOA embedded wallets) |
| Onchain | wagmi v2, viem |
| Arc AppKit | `@circle-fin/app-kit`, `@circle-fin/adapter-viem-v2` |
| Circle Gateway | `@circle-fin/x402-batching` (buyer + facilitator) |
| Database | Neon Postgres, Drizzle ORM |
| State | React context + localStorage (UI), Postgres (all payments) |
| Network | Base mainnet (chain ID 8453) |
| Hosting | Vercel |

---

## Project structure

```
src/
├── app/
│   ├── page.tsx                          # Landing page
│   ├── layout.tsx                        # Root layout + providers
│   ├── sw.ts                             # PWA service worker
│   ├── app/
│   │   ├── layout.tsx                    # App shell — DemoStateProvider, ChatProvider, AppShell
│   │   └── page.tsx                      # Dashboard (DashboardInner)
│   └── api/
│       ├── chat/route.ts                 # AI chat stream — OpenAI GPT-4o-mini
│       ├── voice/transcribe/route.ts     # OpenAI Whisper transcription
│       ├── nanopay/
│       │   ├── sell/route.ts             # x402-protected seller endpoint ($0.01 USDC)
│       │   ├── checkout/route.ts         # Called after every payment — runs x402 round-trip
│       │   ├── pay/route.ts              # Agent pays an x402 URL
│       │   ├── balance/route.ts          # Agent Gateway balance
│       │   ├── deposit/route.ts          # Deposit into Gateway
│       │   └── withdraw/route.ts         # Withdraw from Gateway
│       └── payments/route.ts             # Payment history (GET) + record payment (POST)
├── components/
│   ├── landing/
│   │   ├── value-props.tsx               # "Just talk / Gas-free / Any wallet"
│   │   ├── how-it-works.tsx              # 3-step explainer
│   │   ├── trust-signals.tsx             # "Powered by Circle" — no YO Protocol references
│   │   └── footer.tsx                    # "built with Bluvfi"
│   ├── dashboard/
│   │   ├── bills-screen.tsx              # 16 hardcoded bills, subscribe → PaymentModal flow
│   │   ├── investments-screen.tsx        # 10 hardcoded assets, buy → BuySheet flow
│   │   ├── payments-screen.tsx           # Payment history — shows ⚡ Nanopay badge
│   │   ├── payment-modal.tsx             # arcKit.send() via Privy wallet; createPortal z-[70]
│   │   ├── fund-wallet-sheet.tsx         # Arc AppKit Send + Bridge tabs; createPortal z-[70]
│   │   └── settings-sidebar.tsx          # Profile sidebar with user first name
│   └── chat/
│       ├── chat-sheet.tsx                # AI chat panel
│       ├── pay-bill-confirm-card.tsx     # Inline confirm card for AI-triggered bill payments
│       ├── buy-asset-confirm-card.tsx    # Inline confirm card for AI-triggered investments
│       ├── tool-result-card.tsx          # Routes tool results to confirm cards + display cards
│       ├── message-bubble.tsx
│       ├── thinking-indicator.tsx
│       └── voice-waveform.tsx
├── contexts/
│   ├── demo-state-context.tsx            # localStorage state — paidBillIds, portfolio, payments
│   └── chat-context.tsx                  # Chat sheet open/close, prefill, streaming state
├── hooks/
│   └── use-usdc-balance.ts               # wagmi USDC balance hook (real on-chain)
├── lib/
│   ├── arc-kit.ts                        # arcKit singleton + chain/bridge constants
│   ├── circle-gateway.ts                 # GatewayClient + BatchFacilitatorClient
│   ├── demo-data.ts                      # DEMO_BILLS, DEMO_ASSETS, ASSET_PRICES
│   ├── user-display-name.ts              # getUserFirstName(), getTimeBasedGreeting()
│   ├── constants.ts                      # Chain IDs, token addresses
│   └── ai/
│       ├── tools.ts                      # 10 AI tools — pay_bill/buy_investment return pending
│       ├── system-prompt.ts              # Agent instructions including confirm-card guidance
│       └── window-messages.ts            # Conversation windowing
└── db/
    └── schema.ts                         # goals, activities, bills, investments, payments
```

---

## Database schema

**payments** — all payment records (UI-confirmed + AI-confirmed)

| Column | Type | Notes |
|--------|------|-------|
| id | uuid (PK) | |
| userId | text | Privy user ID |
| type | text | `"bill"` or `"investment"` |
| referenceId | text | Bill ID or asset symbol |
| description | text | Human-readable description |
| amountUsdc | text | Payment amount in USDC |
| status | text | `"completed"` or `"failed"` |
| txHash | text (nullable) | Circle Gateway transaction hash if nanopay settled |
| createdAt | timestamp | |

**bills** / **investments** / **goals** / **activities** — legacy tables retained from earlier build.

---

## Payment flows

### UI-triggered (Subscribe button / Buy button)

```
User taps "Subscribe"
  → PaymentModal opens (createPortal, z-[70])
  → handlePay() called
  → privyWallet.getEthereumProvider()
  → createViemAdapterFromProvider({ provider })
  → arcKit.send({ from, to: RECEIVER, amount, token: "USDC" })
  → onSuccess(txHash)
    → fetch("/api/nanopay/checkout", POST)   ← x402 nanopay settlement
    → markBillPaid(billId, amount, name, nanopay)  ← localStorage + React state
    → Bill card flips to "Active ✓"
    → History tab shows ⚡ Nanopay if settlement succeeded
```

### AI-triggered (chat)

```
User: "Pay my Netflix"
  → AI calls pay_bill({ billName: "Netflix" })
  → Tool returns { pendingPayment: true, billId, billName, amount, icon, description }
  → ToolResultCard renders PayBillConfirmCard inline in chat
  → User taps "Confirm · $15.49 USDC"
  → privyWallet.getEthereumProvider()
  → createViemAdapterFromProvider({ provider })
  → arcKit.send({ from, to: RECEIVER, amount, token: "USDC" })  ← gasless
  → fetch("/api/nanopay/checkout", POST)    ← x402 nanopay settlement
  → markBillPaid(billId, amount, name, nanopay)   ← localStorage + React state
  → fetch("/api/payments", POST)            ← Postgres record
  → Confirm card flips to "Active ✓"
  → Bill card in dashboard also flips to "Active ✓"
  → AI get_payment_history tool reflects the payment
```

Same pattern applies for `buy_investment` → `BuyAssetConfirmCard` → `buyAsset()`.

---

## Key implementation notes

### Privy wallet + Arc AppKit

`payment-modal.tsx`, `pay-bill-confirm-card.tsx`, and `buy-asset-confirm-card.tsx` all use `useWallets()` from `@privy-io/react-auth` to get the user's embedded wallet, not EIP-6963 browser wallet discovery. Privy embedded wallets do not announce via EIP-6963, so any code relying on `window.dispatchEvent(new Event("eip6963:requestProvider"))` silently skips them. The adapter bridge:

```ts
const privyWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
const provider = await privyWallet.getEthereumProvider();
const adapter = await createViemAdapterFromProvider({ provider: provider as any });
```

The `provider as any` cast is required because Privy's `EIP1193Provider` type is not assignable to `createViemAdapterFromProvider`'s parameter type — the runtime shape is compatible.

### Fund wallet sheet (EIP-6963)

`fund-wallet-sheet.tsx` uses a `useFundingWallets()` hook that merges two sources:
- Privy embedded wallet (surfaced as "Bluvfi Wallet" with address pre-populated)
- EIP-6963 discovered wallets (MetaMask, Coinbase Wallet, etc.)

This means any wallet type works for funding, while payments always use the Privy wallet.

### DemoStateProvider placement

`DemoStateProvider` lives in `src/app/app/layout.tsx`, wrapping the entire app shell including `ChatSheet`. This ensures that chat confirm cards (`PayBillConfirmCard`, `BuyAssetConfirmCard`) and dashboard screens (`BillsScreen`, `InvestmentsScreen`) all share the same React context and one call to `markBillPaid` / `buyAsset` updates both the chat UI and the dashboard simultaneously.

### Modal portals and z-index

All payment sheets and modals use `createPortal(modal, document.body)` to render outside the `overflow-y: auto` scroll container in the dashboard. Without this, `position: fixed` modals render at the scroll offset and require scrolling to see. Z-index layering:

| Element | z-index |
|---------|---------|
| ChatInputBar | `z-[60]` |
| PaymentModal, FundWalletSheet, BuySheet | `z-[70]` |

### x402 nanopay checkout

`/api/nanopay/checkout` is called after every successful on-chain payment (both UI path and AI chat confirm path). It runs a full x402 round-trip:
- `client.supports(resourceUrl)` — verifies the sell endpoint requires payment
- `client.pay(resourceUrl)` — signs and submits the nanopayment
- Returns `{ usedNanopay: true, txHash }` on success, `{ usedNanopay: false, simulated: true }` if `CIRCLE_BUYER_PRIVATE_KEY` is not set

This makes the Circle Gateway integration visible in the UI — the History tab shows ⚡ Nanopay on every paid entry.

### User display name and greeting

`src/lib/user-display-name.ts` exports two functions used across dashboard, chat, and settings:

```ts
getUserFirstName(user)       // Google name → Apple firstName → email local part
getTimeBasedGreeting()       // Good night (0–5am) / morning (5–12) / afternoon (12–17) / evening (17–21) / night (21–24)
```

---

## Environment variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

| Variable | Required | Description | Where to get it |
|----------|----------|-------------|-----------------|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Yes | Privy app public ID | [console.privy.io](https://console.privy.io) |
| `PRIVY_APP_SECRET` | Yes | Privy app secret (server-only) | [console.privy.io](https://console.privy.io) |
| `NEXT_PUBLIC_ALCHEMY_API_KEY` | Yes | Alchemy RPC key for Base mainnet | [dashboard.alchemy.com](https://dashboard.alchemy.com) |
| `DATABASE_URL` | Yes | Neon Postgres connection string | [neon.tech](https://neon.tech) |
| `OPENAI_API_KEY` | Yes | OpenAI key for GPT-4o-mini chat and Whisper voice | [platform.openai.com](https://platform.openai.com) |
| `CIRCLE_BUYER_PRIVATE_KEY` | Yes | Private key of agent EOA wallet for server-side nanopayments (server-only, never `NEXT_PUBLIC_`) | Generate a new wallet, export private key, fund with Base mainnet USDC |
| `CIRCLE_SELLER_ADDRESS` | Yes | EVM address that receives x402 seller payments | Any wallet address you control |
| `NEXT_PUBLIC_APP_URL` | Yes | Deployed app URL (used by AI tools for internal API calls) | Your Vercel URL or `http://localhost:3000` locally |
| `CIRCLE_USDC_ADDRESS` | No | Override USDC address on Base mainnet | Default: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `CIRCLE_GATEWAY_WALLET_ADDRESS` | No | Override Circle GatewayWallet contract | Default: fetched from facilitator |

> `CIRCLE_BUYER_PRIVATE_KEY` is server-only and **never** prefixed with `NEXT_PUBLIC_`. Keep it out of version control.

---

## Getting started

### Prerequisites

- Node.js 20+ or Bun
- A [Privy](https://privy.io) app (EOA wallets enabled, Base mainnet)
- A [Neon](https://neon.tech) Postgres database
- An [OpenAI](https://platform.openai.com) API key

### Setup

```bash
git clone https://github.com/Afoxcute/bluvfiAI.git
cd bluvfiAI
npm install --legacy-peer-deps
```

> `--legacy-peer-deps` is required due to `@circle-fin/app-kit` peer dependency constraints.

Copy and fill environment variables:

```bash
cp .env.example .env
# edit .env with your values
```

Push the database schema:

```bash
npx drizzle-kit push
```

Start the dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Hackathon

Built for **Lepton by Canteen** — Circle / Arc hackathon.

**Circle tools used:**
- `@circle-fin/app-kit` — Arc AppKit Send + Bridge (fund wallet sheet) + gasless bill/investment payments
- `@circle-fin/adapter-viem-v2` — bridges Privy embedded wallet EIP-1193 provider into Arc AppKit
- `@circle-fin/x402-batching` — Circle Gateway x402 nanopayments (buyer client + facilitator/seller)

---

## License

MIT
