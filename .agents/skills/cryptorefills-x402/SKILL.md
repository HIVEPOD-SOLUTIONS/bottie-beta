---
name: cryptorefills-x402
description: "Autonomous agent commerce — buy gift cards, top up phones, get eSIMs with USDC on Base or USDC SPL on Solana mainnet via x402 protocol. No account, no OAuth, no API key. No native gas needed (ETH on Base relayed by Cryptorefills; SOL on Solana paid by CDP facilitator). For AI agents with Base or Solana wallets. 10,500+ brands, 180+ countries. Keywords: x402, USDC, USDC SPL, Base, Solana, mainnet-beta, partial-sign, EIP-712, EIP-3009, TransferChecked, compute-budget, VersionedTransaction, pay-skills."
compatibility: "Requires (1) HTTP client and (2) ONE of: (a) Ethereum wallet with USDC on Base (chain 8453) and EIP-712 signing for EIP-3009 transferWithAuthorization, or (b) Solana keypair with USDC SPL on mainnet, a Solana RPC for fresh blockhash, and the ability to build and partial-sign a v0 VersionedTransaction (@solana/web3.js + @solana/spl-token shape). No account or API key needed. No native gas needed on either rail."
metadata:
  author: cryptorefills
  version: "1.3.0"
  homepage: "https://www.cryptorefills.com"
  repository: "https://github.com/cryptorefills/agents"
---

# Cryptorefills x402 — Autonomous Agent Commerce

Fully autonomous purchasing for AI agents with crypto wallets. No accounts, no OAuth, no API keys — just stablecoin and a signing key.

Built on the [x402 protocol](https://docs.x402.org/) — HTTP 402 Payment Required as a machine-to-machine payment standard. Two settlement rails are supported: **Base** (USDC on Ethereum L2, default) and **Solana** (USDC SPL on Solana mainnet, opt-in).

**For human-guided purchases with multiple payment methods**, follow **cryptorefills-buy** instead.
**For browse-only catalog exploration**, follow **cryptorefills-catalog** instead.

## Choose your rail

| Rail | Host | Phase-1 header | Wallet | Asset | Native gas |
|---|---|---|---|---|---|
| **Base** (default) | `x402.cryptorefills.com` | none, or `X-Preferred-Network: base` | EVM, EIP-712 capable | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, chain 8453 | None — Cryptorefills relays |
| **Solana** | `x402.cryptorefills.com` | `X-Preferred-Network: solana` | Solana keypair | USDC SPL mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | None — CDP facilitator pays SOL |
| **Solana** (host-pinned) | `solana.x402.cryptorefills.com` | omit, or `solana` only | Solana keypair | same | None |

**Default-rail recommendation.** If your agent has wallets on both rails and no external constraint, use **Base** — broader EIP-712 tooling, longer payment window (~15 min vs Solana's ~60 s), and the same byte-identical contract that EVM-only agents have used since v1.0. Use **Solana** when the agent already runs there, when SOL avoidance matters, or when a registry / marketplace (e.g., pay-skills) demands a Solana-mainnet 402 challenge by default — in that case use the `solana.x402.cryptorefills.com` host so the rail is host-pinned and unambiguous.

## When to Activate

- Agent has a wallet on Base (USDC, EIP-712) **or** on Solana (USDC SPL, can partial-sign v0 transactions)
- Task requires autonomous purchasing without human payment interaction
- No account setup, OAuth flow, or API key management is desired
- Keywords: "buy with USDC", "USDC SPL", "autonomous purchase", "agent commerce", "x402 payment", "programmatic gift card", "Solana mainnet-beta", "partial-sign", "VersionedTransaction", "compute-budget", "pay-skills registry", "no SOL needed", "no ETH needed"
- Use case: automated gift card procurement, travel eSIM provisioning, programmatic rewards, registry-driven Solana payments

## Requirements

### Base rail

| Requirement | Details |
|-------------|---------|
| USDC on Base | Chain 8453, contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| EIP-712 signing | Sign typed data for `transferWithAuthorization` (EIP-3009) |
| ETH for gas | **Not required** — Cryptorefills relays the authorization on-chain |
| HTTP client | Standard REST API calls |
| Account | **None required** |

### Solana rail

| Requirement | Details |
|-------------|---------|
| USDC SPL on Solana mainnet | Mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals |
| Solana keypair | 64-byte Ed25519 secret (Phantom / Solflare export format works) |
| Solana RPC access | For fresh `recentBlockhash`. Default `https://api.mainnet-beta.solana.com`; any reliable RPC works |
| v0 transaction signing | Build a `VersionedTransaction` with the canonical 3-instruction shape and partial-sign — see protocol.md |
| SOL for gas | **Not required** — the CDP facilitator pays SOL gas from its pool |
| HTTP client | Standard REST API calls |
| Account | **None required** |

## Spending Safeguards

Autonomous agents spending real money require strict controls:

- **Set a per-session spending limit** before starting (default: $100 max per session, $50 max per transaction — increase only if the user explicitly requests it).
- **Verify the order amount** from the 402 response before signing — never sign blindly.
- **Use a dedicated wallet** per rail with only the necessary stablecoin balance.
- **Never log, expose, or share the wallet's private key / secret** — use environment variables or a secret manager.
- **Log every transaction**: `order_id`, product, amount, wallet address, rail, tx signature/hash.
- **Never sign for more** than `maxAmountRequired` in the 402 response.
- **Validate `payTo`** against the manifest at `/.well-known/x402.json` **on the same host** you sent Phase 1 to (the multi-rail host and the Solana-only host publish different deposit wallets).

Solana-specific:
- **`payTo` is the OWNER pubkey, NEVER an ATA.** Derive the recipient ATA from `(payTo, mint)`. Signing a transfer treating `payTo` as an ATA will fail.
- **Verify `extra.feePayer`** matches the value from PAYMENT-REQUIRED before partial-signing — and use it as the transaction's `payerKey`.
- **Re-fetch `recentBlockhash` immediately before partial-signing.** The validity window is ~60 s; the gateway clamps `maxTimeoutSeconds` to 60 to flag this. Do not insert user prompts between Phase 1 and Phase 2 on Solana.
- **Assert the built transaction has exactly 3 instructions** (compute-unit limit, compute-unit price, TransferChecked) before serializing.
- **Use SPL `TransferChecked` (tag `0x0c`), not `Transfer` (`0x03`).** Plain `Transfer` is rejected by CDP with `unknown_error`.

General:
- Gift card codes (`voucher_code`) are cash-like — store securely, never share publicly or write to logs.
- Digital goods are non-refundable once delivered.
- Terms: https://www.cryptorefills.com/terms/

Manifests are served at `/.well-known/x402.json` on each host (multi-rail and Solana-only publish different deposit wallets — verify against the host you actually used).

**Always send Phase 2 to the same host as Phase 1.** The session backing `X-Session-Id` is host-affine; cross-host POST risks a session lookup miss.

## Core Workflow

```
GET  /v1/brands          → discover brands
GET  /v1/catalog         → get products and prices
POST /v1/orders          → 402 + PAYMENT-REQUIRED + X-Session-Id
   ↓ sign (EIP-712 for Base, partial-sign v0 tx for Solana)
POST /v1/orders          → submit with PAYMENT-SIGNATURE [+ X-Session-Id] → 200
GET  /v1/orders/{id}     → poll until delivered
```

The flow, REST contract, and order/delivery model are identical on both rails. Only Phase-1 header selection, the `extra` block on PAYMENT-REQUIRED, and the signing primitive differ.

## Step-by-Step

### 1. Browse Brands

```http
GET /v1/brands?country_code=us
```

Returns available brands for the country. Each entry includes `brand_name`, `family`, `category`, `min`, `max`.

Country codes are **lowercase** ISO 3166-1 Alpha-2 (`us`, `it`, `br`) regardless of rail. If receiving a country code from the catalog or buy skills (which use uppercase), convert to lowercase before using x402 endpoints.

### 2. Get Catalog

```http
GET /v1/catalog?country_code=us&brand_name=Amazon.com
```

Returns products with `product_id`, `is_range`, `currency`, `price_usdc`, and either `denomination` (fixed) or `min_value`/`max_value` (range).

- **Fixed products** (`is_range: false`): use `product_id` directly. Omit `product_value`. Face value is `denomination` in `currency` units.
- **Range products** (`is_range: true`): set `items[].product_value` to the desired amount, **in the brand's local `currency`** (NOT USD). E.g. for a €5 Amazon.nl card with `currency: "EUR"`, send `product_value: 5`. The 402 response will quote the USDC amount to actually settle (typically `price_usdc` ± a small spread).

### Pre-flight: Check stablecoin balance

Before ordering, verify your wallet has sufficient stablecoin on the chosen rail:

- **Base**: call `balanceOf(walletAddress)` on `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- **Solana**: call `getTokenAccountBalance` on the sender ATA — `getAssociatedTokenAddress(mint=EPjF…WEGGkZwyTDt1v, owner=agent)`. **No SOL balance needed.**

The `price_usdc` from the catalog is indicative; the exact amount is confirmed in the 402 response.

### 3. Create Order — Phase 1 (Get Payment Requirements)

**Base (default):**

```bash
curl -X POST https://x402.cryptorefills.com/v1/orders \
  -H "Content-Type: application/json" \
  -d '{
    "email": "delivery@example.com",
    "items": [{
      "product_id": "abc123",
      "beneficiary_account": "recipient@example.com",
      "product_value": 25
    }]
  }'
# → HTTP 402 with PAYMENT-REQUIRED and X-Session-Id headers
```

**Solana (header opt-in):**

```bash
curl -X POST https://x402.cryptorefills.com/v1/orders \
  -H "Content-Type: application/json" \
  -H "X-Preferred-Network: solana" \
  -d '<same body>'
```

**Solana (host-pinned):**

```bash
curl -X POST https://solana.x402.cryptorefills.com/v1/orders \
  -H "Content-Type: application/json" \
  -d '<same body>'
```

`product_value` is required for range products; omit for fixed-denomination products. Optional: add `"callback_url": "https://..."` for webhook delivery notifications instead of polling.

**Capture two response headers**:
- `PAYMENT-REQUIRED` — base64url-encoded JSON of payment requirements (per-rail shape below).
- `X-Session-Id` — UUID. **Echo on Phase 2** (required for Solana, optional for Base).

#### PAYMENT-REQUIRED — Base example

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "maxAmountRequired": "25000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "extra": { "name": "USD Coin", "version": "2", "decimals": 6 },
    "payTo": "0x...",
    "description": "$25.00 Amazon Gift Card"
  }],
  "expiresAt": 1830000000
}
```

#### Solana deltas vs Base (full Solana example in `protocol.md`)

| | Base | Solana |
|---|---|---|
| `network` | `eip155:8453` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (full CAIP-2) |
| `asset` | EVM contract | SPL mint, base58 (`EPjF…WEGGkZwyTDt1v` for USDC) |
| `extra` | `{name, version, decimals}` | `{feePayer}` — use as `payerKey` |
| `payTo` | recipient wallet | recipient **OWNER** pubkey (ATA derived facilitator-side) |
| `expiresAt` window | ~15 minutes | ~60 seconds |

### 4. Sign Payment

#### Base — EIP-712 / EIP-3009

Sign typed data for `transferWithAuthorization`.

**Domain**: USDC contract on Base.
**Types**: `TransferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)`.

| Field | Value |
|-------|-------|
| `from` | Your wallet address |
| `to` | `payTo` from 402 response |
| `value` | `maxAmountRequired` from 402 response |
| `validAfter` | `0` |
| `validBefore` | `expiresAt` from the 402 response (Unix seconds) |
| `nonce` | Random 32-byte hex |

See `references/protocol.md` for exact EIP-712 typed data structure.

#### Solana — partial-sign v0 transaction

Build a v0 `VersionedTransaction` with **exactly 3 instructions, in order**: ComputeBudget set-limit (200_000 units) → ComputeBudget set-price (1000 microLamports) → SPL `createTransferCheckedInstruction` (tag `0x0c`, NOT `Transfer` `0x03`). Use `mint = asset`, `senderAta = getAssociatedTokenAddress(mint, signer)`, `recipientAta = getAssociatedTokenAddress(mint, payTo)` (where `payTo` is the **owner**), `payerKey = extra.feePayer`, fresh `recentBlockhash` from a Solana RPC. Partial-sign with `tx.sign([signer])` — leave the feePayer slot for CDP. Serialize ≤ 1232 bytes.

See `references/protocol.md` for the full recipe.

### 5. Complete Order — Phase 2

Re-POST the same body with `PAYMENT-SIGNATURE`. Echo `X-Session-Id` from Phase 1 (required for Solana).

#### Base

```bash
curl -X POST https://x402.cryptorefills.com/v1/orders \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <base64url-encoded JSON>" \
  -d '<same body as phase 1>'
# → HTTP 200
```

`PAYMENT-SIGNATURE` payload (then base64url-encode the JSON):

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:8453",
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0xYourWallet",
      "to": "0xPayToAddress",
      "value": "25000000",
      "validAfter": "0",
      "validBefore": "1830000000",
      "nonce": "0xRandomBytes32"
    }
  }
}
```

#### Solana

```bash
curl -X POST https://x402.cryptorefills.com/v1/orders \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <base64url-encoded JSON>" \
  -H "X-Session-Id: <UUID from Phase 1 response>" \
  -d '<same body as phase 1>'
# → HTTP 200
```

`PAYMENT-SIGNATURE` payload (base64url-encode the outer JSON; the inner `payload.transaction` is plain base64):

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payload": {
    "transaction": "<plain-base64 of serialized v0 transaction>"
  }
}
```

> **Encoding rule.** The **outer** `PAYMENT-SIGNATURE` wrapper is **base64url** for both rails. Only the **inner** `payload.transaction` field on Solana is plain base64 (Solana ecosystem convention; opaque pass-through to the facilitator). Don't unify them.

**Server responds with HTTP 200**:
```json
{
  "order_id": "cr_abc123",
  "status": "processing",
  "estimated_delivery_seconds": 60,
  "poll_url": "/v1/orders/cr_abc123"
}
```

### 6. Track Delivery

```http
GET /v1/orders/{order_id}
```

Poll every 5–10 seconds until `status` is `completed` or `failed`. Stop polling after 10 minutes and report the order as potentially stuck — contact `support@cryptorefills.com` with the `order_id`.

When `completed`, the `deliveries` array contains:
- `voucher_code` — gift card redemption code
- `pin` — PIN if required
- `url` — redemption URL if applicable
- `brand_name`, `product_name` — what was purchased

## Worked Example: €5 Amazon.nl gift card on Solana

End-to-end check that the per-step instructions compose. Real numbers, anonymized wallet:

```bash
# 1. Discover Amazon.nl
curl 'https://x402.cryptorefills.com/v1/brands?country_code=nl' | jq '.[] | select(.family|test("Amazon"))'
#   → {"brand_name":"Amazon.nl","family":"Amazon.nl","category":"e-commerce", ...}

# 2. Find a range product priced in EUR
curl 'https://x402.cryptorefills.com/v1/catalog?country_code=nl&brand_name=Amazon.nl' | jq '.[0]'
#   → {"product_id":"amzn-nl-range","is_range":true,"currency":"EUR",
#      "min_value":5,"max_value":500,"price_usdc":"5.42", ...}
#   1 EUR isn't offered (min is 5 EUR) — pick 5 EUR.

# 3. Phase 1 — opt into Solana
curl -i -X POST https://x402.cryptorefills.com/v1/orders \
  -H "Content-Type: application/json" \
  -H "X-Preferred-Network: solana" \
  -d '{"email":"agent@example.com",
       "items":[{"product_id":"amzn-nl-range",
                 "beneficiary_account":"user@example.com",
                 "product_value":5}]}'
#   → HTTP/1.1 402
#      X-Session-Id: 3f9c1a8b-...           ← capture, echo on Phase 2
#      PAYMENT-REQUIRED: <base64url JSON>   ← decode for accepts[0]
#
#   accepts[0] decoded:
#     network:           solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
#     asset:             EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
#     maxAmountRequired: "5420000"          ← 5.42 USDC
#     payTo:             <owner pubkey>     ← derive recipient ATA from this
#     extra.feePayer:    <CDP pubkey>       ← use as transaction.payerKey
```

```js
// 4. Decode PAYMENT-REQUIRED, verify budget, build the partial-signed v0 tx
import {ComputeBudgetProgram, Connection, Keypair, PublicKey,
        TransactionMessage, VersionedTransaction} from '@solana/web3.js';
import {createTransferCheckedInstruction, getAssociatedTokenAddress} from '@solana/spl-token';
import bs58 from 'bs58';

// 4a. Parse the 402 response
const paymentRequired = JSON.parse(
  Buffer.from(phase1Headers['payment-required'], 'base64url').toString());
const sessionId = phase1Headers['x-session-id'];
const {payTo, asset, maxAmountRequired, extra} = paymentRequired.accepts[0];

// 4b. Spending-safeguard checks BEFORE signing
const SPEND_LIMIT_ATOMIC = BigInt(50_000_000);              // $50 = 50e6 atomic USDC
if (BigInt(maxAmountRequired) > SPEND_LIMIT_ATOMIC) throw new Error('over budget');
if (asset !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') throw new Error('wrong mint');

// 4c. Build the transaction
const signer       = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_SIGNER_KEY));
const conn         = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const mint         = new PublicKey(asset);
const owner        = new PublicKey(payTo);                  // OWNER, not an ATA
const feePayer     = new PublicKey(extra.feePayer);         // CDP signs this slot

const senderAta    = await getAssociatedTokenAddress(mint, signer.publicKey);
const recipientAta = await getAssociatedTokenAddress(mint, owner);
const {blockhash}  = await conn.getLatestBlockhash('finalized');  // 'finalized' is older but accepted by all validators — reduces timing sensitivity

const message = new TransactionMessage({
  payerKey:        feePayer,
  recentBlockhash: blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({units: 200_000}),
    ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1000}),
    createTransferCheckedInstruction(senderAta, mint, recipientAta,
                                     signer.publicKey, BigInt(maxAmountRequired), 6),
  ],
}).compileToV0Message();

const tx = new VersionedTransaction(message);
tx.sign([signer]);                                    // partial — leaves feePayer slot
// Assert on the pre-compilation array — MessageV0 exposes `compiledInstructions`, not `instructions`.
// Reading `tx.message.instructions` throws TypeError. Use the source array passed to TransactionMessage.
if (message.version !== 0) throw new Error('expected v0 message');
if (tx.message.compiledInstructions.length !== 3) throw new Error('expected exactly 3 instructions');
if (tx.serialize().length > 1232) throw new Error('tx too large');

const txB64       = Buffer.from(tx.serialize()).toString('base64');     // inner: plain base64
const inner       = {x402Version: 2, scheme: 'exact',
                     network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                     payload: {transaction: txB64}};
const headerValue = Buffer.from(JSON.stringify(inner)).toString('base64url');  // outer: base64url
```

```bash
# 5. Phase 2 — same host as Phase 1, echo X-Session-Id from step 3
curl -X POST https://x402.cryptorefills.com/v1/orders \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <headerValue from step 4c>" \
  -H "X-Session-Id: <sessionId from step 4a>" \
  -d '<same body as Phase 1>'
#   → HTTP/1.1 200
#      {"order_id":"cr_xxx","status":"processing","poll_url":"/v1/orders/cr_xxx", ...}

# 6. Poll
curl https://x402.cryptorefills.com/v1/orders/cr_xxx
#   → {"status":"completed",
#      "deliveries":[{"voucher_code":"XXXX-YYYY-ZZZZ","brand_name":"Amazon.nl", ...}]}
```

If steps 1–6 don't compose for your scenario, the failure is documented in `references/troubleshooting.md`.

### Field Name Mapping (x402 vs MCP)

If switching between x402 and MCP skills, note these field name differences:

| Concept | x402 (this skill) | MCP (cryptorefills-buy) |
|---|---|---|
| Gift card code | `voucher_code` | `deliverable.pin_code` |
| PIN | `pin` (separate field) | included in `pin_code` |
| Order status | `status` (single field) | `order_state` + `payment_state` |
| Order ID format | `cr_` prefixed | UUID |

## Critical Gotchas

### Both rails

- **Country codes**: lowercase for x402 endpoints (`us`, not `US`). MCP skills use uppercase — different endpoint, different rule.
- **Brand names**: case-sensitive — use exact values from `/v1/brands` response.
- **`X-Preferred-Network` value**: case-sensitive lowercase — `base` or `solana` only. `Base` or `Solana` (capitalized) returns `400 invalid_network` on the multi-rail host.
- **Amount precision**: use the exact `maxAmountRequired` from 402 — do not round or modify.
- **Outer encoding**: `PAYMENT-SIGNATURE` outer wrapper is **base64url** for both rails (matches the gateway's decoder).
- **No rail mixing**: a session is pinned to the rail chosen on Phase 1. Don't try to switch rails on Phase 2.
- **Same-host Phase 2**: POST Phase 2 to the same host you used for Phase 1. Sessions are host-affine.

### Base

- **USDC contract**: must be exactly `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base.
- **Chain ID**: must be `8453` (Base mainnet). Wrong chain = invalid signature.
- **Payment timeout**: the 402 `expiresAt` field gives the deadline (~15 min). Sign and resubmit before it expires.
- **Nonce**: must be unique per transaction. Cryptographically random 32 bytes.
- **EIP-712 domain**: must match the USDC contract's domain separator on Base.

### Solana

- **Network string**: must be the full CAIP-2 `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, not `"solana"` or `"solana-mainnet"`.
- **`payTo` is the OWNER pubkey, not an ATA.** The facilitator derives the recipient ATA from `(owner, mint)`.
- **Use `TransferChecked` (`0x0c`), not `Transfer` (`0x03`).** CDP rejects the latter with `unknown_error`.
- **Exactly 3 instructions, in order**: ComputeBudget set-limit, ComputeBudget set-price, TransferChecked. CDP enforces a 3-to-6 range.
- **`payerKey` = `extra.feePayer`** from PAYMENT-REQUIRED. CDP signs that slot at settle and pays SOL gas.
- **Tx packet limit**: 1232 bytes. The canonical 3-instruction shape fits comfortably.
- **Blockhash window**: ~60 s. Re-fetch immediately before partial-signing; do not insert user prompts between Phase 1 and Phase 2.
- **Echo `X-Session-Id`** from the Phase 1 response on Phase 2 — required (the SPL transaction is opaque so the gateway has no other way to look up the session).
- **Inner encoding**: `payload.transaction` inside the PAYMENT-SIGNATURE JSON is plain base64 (Solana convention) — only the outer wrapper is base64url.

## References

Load references only when you need deeper detail than what's in this skill file.

| File | Load when... | Content |
|------|-------------|---------|
| `references/protocol.md` | You need the exact signing recipe — EIP-712 domain/types for Base, or the full `VersionedTransaction` build for Solana | Two-phase flow, headers, per-rail PAYMENT-REQUIRED shape, Base EIP-712 / EIP-3009 detail, Solana 3-instruction recipe |
| `references/endpoints.md` | You need exact request/response schemas for an API call | REST API reference, Hosts table, full headers list, error-response codes |
| `references/troubleshooting.md` | A request fails or returns an unexpected status | Per-rail error catalogue and recovery patterns |
