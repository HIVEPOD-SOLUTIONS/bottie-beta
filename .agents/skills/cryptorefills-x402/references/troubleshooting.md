# x402 Troubleshooting

Error handling and recovery for x402 autonomous purchases. Organized by category, with rail-specific notes called out.

## Signature Errors

### Invalid Signature (Base)
**Symptom**: 400 or 403 after submitting PAYMENT-SIGNATURE on Base
**Causes and fixes**:

| Cause | Fix |
|-------|-----|
| Wrong EIP-712 domain | Use domain: `name: "USD Coin"`, `version: "2"`, `chainId: 8453`, `verifyingContract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Wrong chain ID | Must be `8453` (Base mainnet) |
| Wrong USDC address | Must be `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Expired `validBefore` | Set to a future timestamp. If expired, restart from Phase 1 |
| Reused nonce | Generate a fresh random 32-byte nonce per transaction |
| Wrong `to` address | Must match `payTo` from the 402 response exactly |
| Wrong `value` | Must match `maxAmountRequired` from 402 exactly |

### Invalid Signature (Solana)
**Symptom**: 400 or 403 after submitting PAYMENT-SIGNATURE on Solana
**Causes and fixes**:

| Cause | Fix |
|-------|-----|
| `unknown_error` from `/verify` | You used SPL `Transfer` (tag `0x03`). Switch to `createTransferCheckedInstruction` (tag `0x0c`). |
| `transaction instructions length mismatch: 1 < 3 or 1 > 6` | Wrong instruction count. Use the exact 3-instruction preamble: ComputeBudget set-limit + ComputeBudget set-price + TransferChecked. |
| `feePayer not managed` | The `extra.feePayer` you used is not recognised by CDP. Restart Phase 1 to get a fresh `extra.feePayer` and use it verbatim. |
| CDP rejection echoes a `"payer":"<pubkey>"` field that doesn't match your `payerKey` | Not a bug. CDP's rejection messages use `"payer"` to mean **the paying agent's wallet** (the SPL `TransferChecked` authority / signer), not the Solana fee payer. The transaction's `payerKey` correctly stays set to `extra.feePayer` (CDP's key) — the field name collision is just CDP's terminology. Don't change `payerKey` in response to this. |
| `blockhash expired` | You took longer than ~60 s between fetching the blockhash and submitting Phase 2. Re-fetch the blockhash and re-sign. |
| Phase 2 rejected with "X-Session-Id required" | You omitted `X-Session-Id` on Solana Phase 2. Echo the UUID from the Phase 1 `X-Session-Id` response header. |
| Wrong `payTo` interpretation | `payTo` is the **owner pubkey, not an ATA**. Derive the recipient ATA from `(payTo, mint)` via `getAssociatedTokenAddress`. |
| Wrong `payerKey` | `payerKey` must be `extra.feePayer` from PAYMENT-REQUIRED, not the agent's own pubkey. |
| Tx too large | Solana packet limit is 1232 bytes. The canonical 3-instruction shape fits comfortably; if you exceed it you've added something extra. |

### Signature Format Error
**Symptom**: Header parsing fails (400)
**Fix**: Ensure the **outer** `PAYMENT-SIGNATURE` value is **base64url**-encoded JSON matching the schema in `protocol.md`. On Solana, the **inner** `payload.transaction` field is plain base64 — don't unify the two encodings.

## Balance Errors

### Insufficient USDC Balance (Base)
**Symptom**: On-chain transaction reverts after signature accepted
**Fix**: Check USDC balance on Base before signing:
```
balanceOf(agentWalletAddress) on 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```
Ensure balance ≥ `maxAmountRequired`.

### Insufficient USDC SPL Balance (Solana)
**Symptom**: Settlement fails after submitting Phase 2
**Fix**: Check the sender's USDC ATA balance before signing:
```
getTokenAccountBalance(getAssociatedTokenAddress(mint=EPjF…WEGGkZwyTDt1v, owner=agent))
```
Ensure balance ≥ `maxAmountRequired`. **No SOL needed** — CDP pays gas.

### Wrong Token
**Symptom**: Balance check shows sufficient funds but transfer fails
**Fix**:
- Base: verify USDC (not USDT, DAI, or native ETH) on **Base chain** specifically.
- Solana: verify the SPL mint matches `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC) on Solana mainnet. Other USDC-named tokens on Solana are imitations.

## Timeout Errors

### Payment Deadline Expired (Base)
**Symptom**: 402 payment requirements expired before signature submission (~15-minute window)
**Fix**: Restart Phase 1 — POST without signature for fresh requirements.

### Blockhash Expired (Solana)
**Symptom**: Phase 2 rejected with `blockhash expired` (~60-second window)
**Fix**: Re-fetch `recentBlockhash`, rebuild the transaction, partial-sign again, resubmit. **Do not insert user prompts between Phase 1 and Phase 2 on Solana** — the window is too short.

### Order Expired
**Symptom**: `GET /v1/orders/{id}` returns `status: "expired"`
**Fix**: Create a new order. Expired orders cannot be paid or recovered. Contact `support@cryptorefills.com` if payment was sent before expiry.

## Network and Rail Errors

### Wrong Rail (Base agent)
**Symptom**: Wallet connected to Ethereum mainnet, Polygon, Arbitrum, etc.
**Fix**: x402 Base rail uses chain 8453 exclusively. Switch wallet network to Base.

### Wrong Network String (Solana)
**Symptom**: 400 / signature mismatch
**Fix**: `network` must be the full CAIP-2 string `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — not `"solana"`, not `"solana-mainnet"`. CDP enforces this exactly.

### invalid_network_for_host
**Symptom**: 400 with `error: "invalid_network_for_host"` on Phase 1
**Fix**: You sent `X-Preferred-Network: base` (or any non-Solana value) to `solana.x402.cryptorefills.com`. Either drop the header / set it to `solana`, or switch to the bare `x402.cryptorefills.com` host.

### Solana settlement temporarily unavailable
**Symptom**: 503 on Phase 1 with this message
**Fix**: CDP `/supported` discovery is failing transiently. **Pre-flight — no order created.** Wait ~30 s and retry, or fall back to Base by sending Phase 1 to `x402.cryptorefills.com` without `X-Preferred-Network`.

### Transaction Pending
**Symptom**: Order stays in `processing` for longer than expected
**Fix**:
- Base: check Base block explorer for the transaction.
- Solana: check Solscan for the partial-signed-then-countersigned transaction.

Network congestion may delay settlement. Continue polling.

## API Errors

### Brand Not Found
**Symptom**: Empty catalog results
**Fix**: Verify `brand_name` matches exactly (case-sensitive) from `/v1/brands` response. Check `country_code` is **lowercase** (x402 endpoints are lowercase regardless of rail).

### Product Not Available
**Symptom**: 422 on order creation
**Fix**: Product may be out of stock or discontinued. Re-query `/v1/catalog` for current availability.

### Invalid Product Value
**Symptom**: 422 when ordering range product
**Fix**: Ensure `product_value` is within `min_value`–`max_value` from catalog. Must be a number, not a string.

### Missing Beneficiary Account
**Symptom**: 400 on order creation
**Fix**: Every item needs `beneficiary_account` — an email address for delivery.

## Recovery Patterns

| Scenario | Action |
|----------|--------|
| Base signature rejected | Check all EIP-712 fields, regenerate nonce, retry |
| Solana signature rejected | Check instruction count + order, confirm `TransferChecked` (not `Transfer`), confirm `payerKey = feePayer`, retry |
| 402 expired (Base) | Re-POST without signature for fresh requirements |
| Blockhash expired (Solana) | Re-fetch blockhash, rebuild + partial-sign, resubmit |
| Order expired | Create new order with same products |
| Insufficient balance (Base) | Fund wallet with USDC on Base, then retry |
| Insufficient balance (Solana) | Fund wallet's USDC ATA on Solana mainnet, then retry. No SOL needed. |
| 503 Solana settlement unavailable | Wait 30 s; retry; or fall back to Base |
| Server 500 during Phase 2 | Check order status via GET before retrying — the server may have processed the payment despite the error response. Otherwise wait 30 s and retry once. If persistent, try later |
| Order failed | Check error details in response. Contact `support@cryptorefills.com` with `order_id` and tx hash / signature |
