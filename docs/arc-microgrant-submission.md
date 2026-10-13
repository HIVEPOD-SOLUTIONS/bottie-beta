# Arc Microgrants — Bluvfi submission

Deadline: **October 14, 2026, 23:59 ET** (DoraHacks: dorahacks.io/hackathon/arc-microgrants)

Fill in the `<…>` placeholders after making the live Arc transactions.

---

## Project name

Bluvfi

## Links

- **Live deployment:** https://bluvfi.xyz (Wallet → 🟣 Arc tab)
- **Public repo:** https://github.com/HIVEPOD-SOLUTIONS/bottie-beta
- **Builder profile:** https://x.com/bluvfi
- **Demo video:** `<link>`
- **Arc mainnet transactions (explorer.arc.io):**
  - Bridge in (USDC arriving on Arc via Circle CCTP forwarder): `<https://explorer.arc.io/tx/…>`
  - Send USDC on Arc from the Arc tab: `<https://explorer.arc.io/tx/…>`
  - Send USDC on Arc from the AI chat: `<https://explorer.arc.io/tx/…>`
  - Real purchase paid with Arc USDC (gift card / top-up): `<https://explorer.arc.io/tx/…>`

## Short description (what it does)

Bluvfi is an AI-powered payments wallet. People pay real-world things such as gift cards, phone top-ups, eSIMs, bills, domains and US stocks from one stablecoin balance. They can do it on screen or by asking the AI agent in plain language. Every payment is confirmed by the user on a card before anything moves.

## What it uses Arc for

USDC on Arc is a first-class balance and payment rail in Bluvfi, running on Arc mainnet (chain 5042):

1. **Bring USDC to Arc.** The Bridge moves USDC from Base, Ethereum, Arbitrum and other chains to Arc using Circle App Kit 1.16. It uses Circle's forwarder, so the user needs no Arc gas to receive.
2. **Hold and send on Arc.** A dedicated Arc tab shows the live Arc USDC balance and explorer link and sends USDC on Arc. Because USDC is Arc's gas token, users only ever need USDC: no second token, no "you need ETH for gas" dead end.
3. **Spend Arc USDC on real purchases.** At the Bitrefill checkout (thousands of gift cards, top-ups and eSIMs), "USDC on Arc" pays straight from the user's wallet. The app gets a live route quote, approves the exact amount (never an unlimited approval), and signs one transaction on Arc. The purchase is delivered once the funds settle. If anything fails, the USDC is refunded to the user's wallet on Arc.
4. **AI agent on Arc.** The chat agent can read the live Arc balance (`get_arc_balance`), send USDC on Arc (`send_usdc_arc`, with a confirm card), and pay purchases with Arc USDC. Each of these needs the user's explicit confirmation.
5. **One payment engine.** Arc goes through Bluvfi's shared 3-layer EVM payment path:
   - first, a gas-sponsored transaction (Privy, EIP-7702);
   - then the user's own wallet, paying gas in USDC on Arc;
   - then Circle App Kit.

   Every Arc payment is recorded in the user's History with its transaction hash.

## Why Arc

Bluvfi's users think in dollars, not gas tokens. On Arc the dollar is also the gas, which removes the most common failure in the app: a user has USDC but no native token to move it. Arc lets the agent pay with exactly one asset, end to end.

## What's next

- Make Arc the default rail for agent payments, with gas fully sponsored.
- Settle more providers (bill payments, stock buys) directly from Arc USDC.
- Pay creator commissions on Bluvfi's open provider network in USDC on Arc.

## Tech

Next.js, Privy embedded wallets, viem, Circle App Kit 1.16 (CCTP + forwarder), LI.FI routing via the bluvfi-xrpl service, Postgres (Neon) with Drizzle.

---

## Short version (if the form has a character limit)

> Bluvfi is an AI payments wallet: people pay gift cards, top-ups, bills, domains and stocks from one stablecoin balance, on screen or by asking the AI. On Arc mainnet, users bridge USDC in with Circle App Kit (forwarder, no Arc gas needed), hold and send USDC on Arc, and spend it on real Bitrefill purchases. Bluvfi signs a single transaction with an exact-amount approval, and failed payments are refunded on Arc. The AI agent can read the Arc balance, send USDC on Arc, and pay with it, each behind a confirm card. Because USDC is Arc's gas, users only ever need dollars.
