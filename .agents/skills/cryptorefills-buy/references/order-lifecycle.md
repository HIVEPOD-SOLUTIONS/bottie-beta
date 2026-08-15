# Order Lifecycle

State machines for payment and order processing on Cryptorefills.

## Payment States

```
WalletCreated ──→ PaymentRequested ──[crypto received]──→ PaymentReceived
                                   ──[timeout]──→ Expired
```

| State | Meaning |
|-------|---------|
| `WalletCreated` | Payment address generated |
| `PaymentRequested` | Awaiting crypto payment |
| `PaymentReceived` | Crypto confirmed on-chain or via Lightning |
| `Expired` | Payment window elapsed |

## Order States

```
WaitingForPayment ──→ Done              (success: paid + delivered)
                  ──→ Expired           (payment window elapsed)
                  ──→ Canceled          (user or system canceled)
                  ──→ WaitingForManualAction  (support review needed)
```

| State | Meaning | Action |
|-------|---------|--------|
| `WaitingForPayment` | Order created, awaiting payment | Present payment details to user |
| `Done` | Paid and delivered | Retrieve codes from deliveries array |
| `Expired` | Payment window elapsed | Create a new order |
| `Canceled` | Order was canceled | Create a new order if still needed |
| `WaitingForManualAction` | Cryptorefills support is reviewing | Inform user; wait for resolution |

## Polling Strategy

After `createOrder`, poll `getOrderStatus` to track progress:

- **Interval**: Every 30 seconds
- **Stop when**: Order state is terminal (`Done`, `Expired`, `Canceled`)
- **WaitingForManualAction**: Keep polling but inform user that support is involved — resolution may take longer

## Payment Window Durations

| Payment Method | Typical Expiration |
|----------------|-------------------|
| Lightning | ~15 minutes |
| Bitcoin (on-chain) | ~60–180 minutes |
| ETH / ERC-20 tokens | ~60–180 minutes |
| USDC / USDT (any chain) | ~60–180 minutes |

Orders not paid within the window transition to `Expired`. Lightning invoices have the shortest window. Always check the order's expiration timestamp from the `createOrder` response when available.

## Delivery

When `order_state` reaches `Done`, the order response includes delivery details:

### Gift Cards (MCP API field names)
- `pin_code` field contains the redemption code (note: the x402 API uses `voucher_code` and `pin` as separate fields — different endpoints, different field names)
- If `pin_code` starts with `http` or `https` → it's a URL the user must visit
- Plain text → enter manually on the brand's website or app

### Mobile Recharge
- Applied automatically to the phone number
- No manual code needed — balance appears on the phone

### eSIMs
- QR code and activation instructions delivered via email
- User scans QR on their device to activate the data plan

## Error Recovery

| Scenario | Recovery |
|----------|----------|
| Order expired | Create a new order with the same products. Previous order's payment address is no longer valid. |
| Underpayment | Order remains in `WaitingForPayment`. If the payment window has not expired, send the remaining amount to the same address. If expired, create a new order and contact support at support@cryptorefills.com with the transaction hash for a refund of the partial payment. |
| Overpayment | Order will be fulfilled normally. The excess amount is typically not refunded automatically. Contact support at support@cryptorefills.com with the transaction hash and order ID to request a refund of the overage. |
| Wrong network | Funds sent to the wrong chain are not visible to Cryptorefills. Contact support at support@cryptorefills.com with the transaction hash — recovery depends on the chain and may not be possible. Create a new order on the correct network. |
| WaitingForManualAction | Cryptorefills support is reviewing the order. Continue polling every 60 seconds. Inform the user that resolution may take up to 24 hours. |
