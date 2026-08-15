# x402 Protocol

The [x402 protocol](https://docs.x402.org/) enables machine-to-machine payments using HTTP 402 Payment Required. Cryptorefills implements x402 v2 on two settlement rails:

- **Base** (EVM, USDC contract on chain 8453) — default
- **Solana** (USDC SPL on Solana mainnet) — opt-in via header or via the `solana.x402.cryptorefills.com` host

The two-phase flow, the REST contract, and the order/delivery model are identical on both rails. Only the signing primitive and the payment-requirements `extra` block differ.

## Two-Phase Flow

```
Client                              Server
  │                                   │
  │  POST /v1/orders                  │
  │  [+ X-Preferred-Network: <rail>]  │
  │──────────────────────────────────→│
  │                                   │
  │  HTTP 402                         │
  │  + PAYMENT-REQUIRED               │
  │  + X-Session-Id                   │
  │←──────────────────────────────────│
  │                                   │
  │  [decode requirements]            │
  │  [sign — EIP-712 or partial-sign] │
  │                                   │
  │  POST /v1/orders                  │
  │  + PAYMENT-SIGNATURE              │
  │  + X-Session-Id (req for Solana)  │
  │──────────────────────────────────→│
  │                                   │
  │  [verify sig, settle on-chain]    │
  │                                   │
  │  HTTP 200 + order receipt         │
  │←──────────────────────────────────│
```

**Phase 1**: Send an order request. Optionally include `X-Preferred-Network: solana` to settle on Solana (otherwise the gateway picks Base, or Solana if reached on `solana.x402.cryptorefills.com`). Server responds with 402, payment requirements, and an `X-Session-Id` UUID.

**Phase 2**: Sign per-rail, then re-send the same body with `PAYMENT-SIGNATURE`. Echo `X-Session-Id` from the Phase 1 response — required on Solana, optional on Base.

## Headers

| Header | Direction | Phase | Required | Notes |
|---|---|---|---|---|
| `X-Preferred-Network` | request | 1 | No | `base` (default) or `solana`. Ignored / rejected on the Solana-only host if it conflicts. |
| `X-Session-Id` | response | 1 | Always emitted | UUID; the gateway's session key. |
| `X-Session-Id` | request | 2 | Required for Solana, optional for Base | Echo verbatim from Phase 1. Base falls back to `authorization.to` lookup. |
| `PAYMENT-REQUIRED` | response | 1 | Always on 402 | base64url-encoded JSON of payment requirements. |
| `PAYMENT-SIGNATURE` | request | 2 | Yes | base64url-encoded JSON wrapping the per-rail signed payload. |

## PAYMENT-REQUIRED Header

base64url-encoded JSON. The shape is rail-specific in the `accepts[].extra` and `accepts[].network` / `accepts[].asset` fields.

### Base (EVM)

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "maxAmountRequired": "25000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "extra": {
        "name": "USD Coin",
        "version": "2",
        "decimals": 6
      },
      "payTo": "0xRecipientWalletAddress",
      "description": "$25.00 Amazon Gift Card"
    }
  ],
  "expiresAt": 1830000000,
  "resource": "POST /v1/orders"
}
```

| Field | Meaning |
|-------|---------|
| `scheme` | Always `"exact"` |
| `network` | `eip155:8453` — Base mainnet |
| `maxAmountRequired` | USDC in atomic units (6 decimals). `25000000` = $25.00 |
| `asset` | USDC contract on Base |
| `extra.name` / `extra.version` | EIP-712 domain `name` / `version` |
| `extra.decimals` | Token decimals (6 for USDC) |
| `payTo` | Destination wallet address for this order |

### Solana

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "maxAmountRequired": "5000000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": {
        "feePayer": "BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F"
      },
      "payTo": "8JxQznqaAgDgarkd9MNhyrDDRF7zuLKvV86WbGV54FA7",
      "description": "$5.00 Amazon.it Gift Card"
    }
  ],
  "expiresAt": 1830000000,
  "resource": "POST /v1/orders"
}
```

| Field | Meaning |
|-------|---------|
| `scheme` | Always `"exact"` |
| `network` | CAIP-2 Solana mainnet — must be the full `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, not `"solana"` or `"solana-mainnet"` |
| `maxAmountRequired` | USDC SPL in atomic units (6 decimals). `5000000` = $5.00 |
| `asset` | SPL mint, base58. Mainnet USDC = `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `extra.feePayer` | CDP-managed pubkey. **Use as the transaction's `payerKey`.** CDP signs that slot at settle time and pays SOL gas. |
| `payTo` | **OWNER pubkey, NOT an ATA.** The facilitator derives the recipient ATA from `(owner, mint)`. |

### Field-shape deltas at a glance

| | Base | Solana |
|---|---|---|
| `network` | `eip155:8453` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| `asset` | EVM contract address | SPL mint, base58 |
| `extra.name` / `version` / `decimals` | present (EIP-712 domain bits) | absent |
| `extra.feePayer` | absent | present, mandatory |
| `payTo` semantics | recipient wallet | recipient OWNER (ATA derived) |
| `expiresAt` window | ~15 minutes | ~60 seconds (clamped by `maxTimeoutSeconds`) |

## Base Signing — EIP-712 / EIP-3009

Base payments use [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) `transferWithAuthorization`, signed via [EIP-712](https://eips.ethereum.org/EIPS/eip-712). No prior `approve()` is needed — a single signature authorizes the transfer, and Cryptorefills relays it on-chain (the agent never needs ETH).

### Domain

```json
{
  "name": "USD Coin",
  "version": "2",
  "chainId": 8453,
  "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
}
```

### Types

```json
{
  "TransferWithAuthorization": [
    { "name": "from", "type": "address" },
    { "name": "to", "type": "address" },
    { "name": "value", "type": "uint256" },
    { "name": "validAfter", "type": "uint256" },
    { "name": "validBefore", "type": "uint256" },
    { "name": "nonce", "type": "bytes32" }
  ]
}
```

### Values

| Field | Source |
|-------|--------|
| `from` | Agent's wallet address |
| `to` | `payTo` from PAYMENT-REQUIRED |
| `value` | `maxAmountRequired` from PAYMENT-REQUIRED |
| `validAfter` | `0` |
| `validBefore` | `expiresAt` from the 402 response (Unix seconds) |
| `nonce` | Cryptographically random 32 bytes (`0x` + 64 hex) |

### PAYMENT-SIGNATURE shape (Base)

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "eip155:8453",
  "payload": {
    "signature": "0x<65-byte hex signature>",
    "authorization": {
      "from": "0xAgentWallet",
      "to": "0xPayToAddress",
      "value": "25000000",
      "validAfter": "0",
      "validBefore": "1830000000",
      "nonce": "0x<random-32-bytes-hex>"
    }
  }
}
```

base64url-encode this JSON, set as `PAYMENT-SIGNATURE`. Values in `authorization` (`value`, `validAfter`, `validBefore`) are JSON strings on the wire but are encoded as `uint256` during EIP-712 hashing.

## Solana Signing — partial-signed v0 transaction

Solana payments use a partial-signed v0 `VersionedTransaction`. The agent signs an SPL `TransferChecked` (only); the CDP facilitator countersigns the `feePayer` slot at settle time and pays SOL gas. **The agent never needs SOL.**

### Required instruction set (exact arity)

The transaction must contain **exactly 3 instructions, in this order**:

1. `ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })`
2. `ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })`
3. SPL `TransferChecked` (instruction tag `0x0c`) — **NOT** plain `Transfer` (tag `0x03`). CDP rejects `Transfer` with `unknown_error` from `/verify`.

The CDP facilitator enforces a 3-to-6 instruction range and rejects payloads outside it (`transaction instructions length mismatch`).

### TransferChecked fields

| Field | Source |
|---|---|
| Source ATA | `getAssociatedTokenAddress(mint, signer.publicKey)` |
| Mint | `asset` from PAYMENT-REQUIRED |
| Destination ATA | `getAssociatedTokenAddress(mint, payToOwner)` — derived from `payTo` (the OWNER) |
| Owner / authority | `signer.publicKey` |
| Amount | `maxAmountRequired` from PAYMENT-REQUIRED, as `BigInt` (atomic units) |
| Decimals | `6` for USDC (no `extra.decimals` is published for Solana — hard-coded for USDC) |

### Transaction assembly

| Field | Value |
|---|---|
| `payerKey` | `extra.feePayer` from PAYMENT-REQUIRED — CDP signs this slot |
| `recentBlockhash` | Fresh from a Solana RPC (default `https://api.mainnet-beta.solana.com`) at commitment `'finalized'` — older but accepted by every validator, reducing timing-sensitivity rejections. Validity ~60–90 s on the Solana network, but the gateway session TTL is 60 s — that's the binding deadline |
| `instructions` | The 3 above, in order |
| Compile to | v0 message — `compileToV0Message()` |
| Wrap in | `new VersionedTransaction(message)` |
| Sign | `tx.sign([signer])` — partial; leave the `feePayer` slot for CDP |
| Serialize | `tx.serialize()` — packet limit **1232 bytes** |

### PAYMENT-SIGNATURE shape (Solana)

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

base64url-encode the **outer JSON** wrapper and set as `PAYMENT-SIGNATURE`. The **inner `payload.transaction`** is plain base64 (Solana ecosystem convention); the gateway forwards it opaquely to the CDP facilitator.

> **Encoding note.** The outer PAYMENT-SIGNATURE wrapper is base64url for **both** rails (matches the gateway's `Base64.getUrlDecoder()`). Only the inner `payload.transaction` field on Solana uses plain base64. Don't unify them — emit base64url for the outer wrapper and base64 for the Solana inner transaction.
>
> **Why the reference signer also works.** `scripts/sign-payment-solana.mjs` emits `Buffer.toString('base64')` (plain base64) for the outer wrapper, not base64url. This happens to be safe for this specific payload: the outer JSON character set (`A-Za-z0-9+/=:.,"{}` plus the inner base64 content) cannot produce a 6-bit window of `0b111110` or `0b111111` in the base64 output, so plain-base64 and base64url are character-identical here. Java's URL decoder also accepts the `=` padding from plain base64. Agents should still emit base64url to match the spec — the equivalence is incidental, not contractual.

### Reference signer

`scripts/sign-payment-solana.mjs` in the gateway repo (`atomicrails/x402`) is the canonical recipe — uses `@solana/web3.js` + `@solana/spl-token`, emits the exact 3-instruction shape above. Agents in the wild won't have repo access; the recipe in this document is self-contained.

### Phase-2 timing

The 60-second blockhash window is short. Don't insert any user prompts between Phase 1 and Phase 2 on Solana. If the agent must wait, restart from Phase 1 to refresh `expiresAt` and the blockhash. The gateway clamps `paymentRequirements.maxTimeoutSeconds` to 60 specifically to flag this bound.

## Security Considerations

- **Verify amount**: check `maxAmountRequired` against your spending limit before signing.
- **Verify `payTo`**:
  - On Base: confirm the destination is associated with Cryptorefills (cross-check the manifest at `/.well-known/x402.json` on the host you sent Phase 1 to).
  - On Solana: confirm `payTo` is an OWNER pubkey, not an ATA. The correct destination is `getAssociatedTokenAddress(mint, payTo)` — the ATA derived from `payTo` treated as the owner. Signing a transfer to `payTo` directly (treating it as an ATA) is wrong and the funds will land in the wrong account.
- **Verify `extra.feePayer` (Solana)**: must match the CDP-published value. A wrong feePayer means CDP refuses to settle.
- **Nonce uniqueness (Base)**: never reuse a nonce — cryptographically random per transaction.
- **Blockhash freshness (Solana)**: re-fetch the blockhash immediately before partial-signing, never reuse.
- **Instruction-count assertion (Solana)**: assert exactly 3 instructions before serializing. Assert on `tx.message.compiledInstructions.length` (or the pre-compilation array passed to `TransactionMessage`) — `MessageV0` does not expose `tx.message.instructions`; reading it throws `TypeError`.
- **Domain verification (Base)**: EIP-712 domain must match USDC on Base (chain 8453).
- **Wallet isolation**: dedicated wallet, limited balance per rail.
- **No rail mixing**: a session is pinned to the rail chosen in Phase 1. Don't try to switch rails on Phase 2 — the session ID won't match and the signature is rejected.
