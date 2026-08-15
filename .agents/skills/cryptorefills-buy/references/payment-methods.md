# Payment Methods

Cryptorefills supports multiple cryptocurrencies across various blockchain networks.

## Discovering Payment Options

1. Call `getCurrencies` — returns all supported coins with suspension status
2. Call `getPaymentViasWithCurrencies` — returns payment methods mapped to currencies and networks

Always check these before presenting payment options, as availability may change.

## Payment Method Identifiers

These are the actual `payment_method` values returned by `getPaymentViasWithCurrencies`. Use them in `validateOrder` and `createOrder`.

| Payment Method ID | Description |
|-------------------|-------------|
| `USER_WALLET` | Direct crypto payment — user sends to a wallet address (BTC, ETH, LTC, USDC, USDT, etc.) |
| `GATE_PAY` | Gate.io Pay — USDT, USDC, BTC, ETH |
| `GATE_PAY_WEB` | Gate.io Pay (web) — USDT, USDC, BTC, ETH |
| `KUCOIN_PAY` | KuCoin Pay — USDC |
| `BUYDL` | BuyDL — USDC |

The exact list of payment methods and their supported currencies changes over time. Always call `getPaymentViasWithCurrencies` to get the current list.

## Supported Currencies

Verified active currencies from `getCurrencies`:

| Currency | Status |
|----------|--------|
| BTC | Active |
| USDC | Active |
| USDT | Active |
| ETH | Active |
| LTC | Active |
| SOL | Active |
| TON | Active |
| TRX | Active |
| SUI | Active |
| USDE | Active |
| FDUSD | Active |
| USDT.e | Active |
| USDC.e | Active |
| DOGE | Active |
| DAI | Active |
| EUROC | Active |
| WLD | Active |
| PYUSD | Active |

## Recommended for Agents

**Autonomous agents with wallets**:
→ Use **cryptorefills-x402** skill for USDC on Base. No account needed, two-phase x402 protocol, EIP-712 signing. The fastest path for programmatic purchasing.

**Guided human-in-the-loop purchases**:
1. **`USER_WALLET` with BTC** — Widely held, SegWit address + BIP21 URI
2. **`USER_WALLET` with USDC** — Predictable stablecoin amount, multiple chains
3. **`GATE_PAY` or `KUCOIN_PAY`** — Exchange-based payment, instant if user has an account

## Network Values

Use the exact `network` string from `getPaymentViasWithCurrencies` in `payment.network`. Common mappings:

| Coin | `payment.network` value |
|------|------------------------|
| BTC | `Mainnet` |
| ETH | `ETH Mainnet` |
| USDC | `Base`, `Polygon (Matic)`, `Arbitrum`, `Solana`, `ETH Mainnet` |
| USDT | `Polygon (Matic)`, `Tron`, `ETH Mainnet` |
| SOL | `Solana` |
| LTC | `Mainnet` |

Always call `getPaymentViasWithCurrencies` to get the current list — use the `name` field from the `networks` array verbatim.

## Payment Flow

After `createOrder`, the response includes:

| Field | Description |
|-------|-------------|
| `wallet_address` | Destination crypto address |
| `coin_amount` | Exact amount in payment currency |
| `qr_text` | Payment URI (BIP21, EIP-681, Lightning invoice) |
| `qr_url` | URL to QR code image for mobile wallets |

**Steps**:
1. Present payment details to user (or send programmatically)
2. User sends exact `coin_amount` to `wallet_address`
3. Poll `getOrderStatus` every 30 seconds
4. Wait for `payment_state: "PaymentReceived"` and `order_state: "Done"`

## Pricing Model

- Product prices are denominated in **fiat** (USD, EUR, local currency)
- Crypto amount is calculated at **order creation time** using live exchange rates
- Exchange rate is **locked** for the duration of the payment window
- **Underpayment**: order stays in `WaitingForPayment`. Send the remaining amount if window is still open, or create a new order and contact support for a refund
- **Overpayment**: order is fulfilled normally. Contact support@cryptorefills.com with tx hash and order ID for a refund of the excess
- Always send the exact amount to avoid these scenarios

## Price Currency vs Payment Currency

| Concept | Meaning |
|---------|---------|
| Price currency | The fiat denomination shown to the user (e.g., $25 Amazon) |
| Payment currency | The crypto sent to Cryptorefills (e.g., 0.00042 BTC) |

Use `getProductPrice` to get the exact crypto amount before creating an order.
