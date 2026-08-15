# MCP Tools Reference

All tools available on the Cryptorefills MCP server at `https://api.cryptorefills.com/mcp/http`.

## Catalog Tools (read-only)

### searchProducts

Free-text product search across the catalog.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country_code` | string | Yes | Uppercase Alpha-2 ISO (e.g., `US`, `DE`) |
| `q` | string | Yes | Search query text (e.g., "Netflix", "Steam") |
| `lang` | string | No | Language code (default: `en`) |

**Important**: The search parameter is `q` (not `query`) and language is `lang` (not `language`).

Returns: Array of matching products with IDs, denominations, pricing, `is_dynamic` flag.

### listBrands

Browse all brands available in a country.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country_code` | string | Yes | Uppercase Alpha-2 ISO |
| `promo_code` | string | No | Promotional code |

Returns: Categories array containing brand objects with `brand`, `brand_id`, `family`, `category`, `min`, `max`, `kind`, `is_out_of_stock`.

**Note**: Brand names may include suffixes (e.g., "Claro Credits" not "Claro", "Vivo Credits" not "Vivo"). Always use the exact `brand` value from the response.

### listProductsForCountry

Full product catalog with advanced filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country_code` | string | Yes | Uppercase Alpha-2 ISO |
| `brand_name` | string | No | Filter by brand name (e.g., `"Steam"`, `"Amazon.com"`, `"Claro Credits"`) — use values from `listBrands` response |
| `family_name` | string | No | Filter by brand family name (e.g., `"Amazon.com"`, `"Steam"`, `"eSIM"`) |
| `coin` | string | No | Filter by payment cryptocurrency |
| `payment_method` | string | No | Filter by payment method |
| `lang` | string | No | Language code (default: `en`) |

Returns: Detailed product array with IDs, denominations, min/max for range products, `is_dynamic` flag.

### getCurrencies

List supported payment cryptocurrencies.

**No parameters.**

Returns: Array of currency objects (name, symbol, suspended status, logo URL).

### getPaymentViasWithCurrencies

Payment methods with currency and network mappings.

**No parameters.**

Returns: Payment method objects with supported currencies, blockchain networks, and routing details.

## Purchase Tools

### purchaseElicitation

Interactive stateful purchase guide. The simplest path from intent to order.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `session_token` | string | No | Token from previous step (omit for first call) |
| `answer` | string | No | User's answer to the previous question |
| `action` | string | No | `"back"` to revert one step |
| `lang` | string | No | Language code for prompts |

**Flow**:
1. First call: send `{}` → receive `session_token` + first question
2. Each subsequent call: send `session_token` + user's `answer`
3. Repeat until `status` is `complete` or `error`
4. Send `action: "back"` to undo a step

Returns: `session_token`, `status` (in_progress / complete / error), `question` or order details.

### getProductPrice

Calculate exact pricing for a **range product only** (`is_dynamic: true`). Not needed for fixed-denomination products — their prices are already in the `listProductsForCountry` response.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `brand_name` | string | Yes | Brand display name from `listBrands` (e.g., `"Amazon.com"`, `"Amazon.it"`) |
| `country_code` | string | Yes | Uppercase Alpha-2 ISO (e.g., `US`, `IT`) |
| `face_value` | number | Yes | Desired amount as a number (e.g., `50`, `75`, `200`). Must be within the product's min–max range. |
| `coin` | string | Yes | Payment cryptocurrency symbol (e.g., `BTC`, `USDC`, `ETH`) |
| `promo_code` | string | No | Promotional code for discounts (e.g., `"SAVE10"`) |

Returns: `product_id`, `is_dynamic`, `range` (min/max/currency), `coin_amount`, `coin`, `payment_method`, `delivery_type`.

### validateOrder

Pre-submission validation. Always call before `createOrder`. Uses a `body` wrapper.

```
validateOrder(body={
  payment: {type: "via", payment_via: "USER_WALLET", coin: "BTC", network: "Mainnet"},
  deliveries: [
    {denomination: "25 USD", brand_name: "Steam", beneficiary_account: "user@example.com", country_code: "US"}
  ]
})
```

**`body.payment`** (required):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | `"via"` for crypto wallet payments |
| `payment_via` | string | Yes | Payment method ID from `getPaymentViasWithCurrencies` (e.g., `"USER_WALLET"`, `"GATE_PAY"`) |
| `coin` | string | Yes | Cryptocurrency symbol (e.g., `"BTC"`, `"USDC"`, `"ETH"`) |
| `network` | string | Yes | Blockchain network (e.g., `"Mainnet"`, `"Solana"`, `"Polygon (Matic)"`, `"Base"`) |

**`body.deliveries[]`** (required, array of 1–10 items):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `denomination` | string | Yes | For **fixed** products: the exact denomination string from `listProductsForCountry` (e.g., `"25 USD"`, `"15 BRL"`, `"1 GB 7 days"`). For **range** products (`is_dynamic: true`): use the literal string `"range"`. |
| `brand_name` | string | Yes | Exact brand name from `listBrands` (e.g., `"Steam"`, `"Claro Credits"`) |
| `beneficiary_account` | string | Yes | Email for gift cards/eSIMs, E.164 phone for mobile recharge (e.g., `"+5511999887766"`) |
| `country_code` | string | Yes | Uppercase Alpha-2 ISO (e.g., `"US"`, `"BR"`) |
| `product_value` | string | No | For range products only — the desired face value amount (e.g., `"75"`, `"50"`). Required when `denomination` is `"range"`. |

**Optional `body` fields**: `user` (object with `email`), `promo_code`, `lang`, `refund_wallet_address`.

Returns: `coin`, `coin_amount`, `deliveries[]` (with delivery details), `summary` (pricing breakdown), `problems[]` (validation errors). Empty `problems` = valid.

### createOrder

Submit the purchase order. **Same `body` schema as `validateOrder`**, plus `user` is required.

```
createOrder(body={
  user: {email: "buyer@example.com"},
  payment: {type: "via", payment_via: "USER_WALLET", coin: "BTC", network: "Mainnet"},
  deliveries: [
    {denomination: "25 USD", brand_name: "Steam", beneficiary_account: "user@example.com", country_code: "US"}
  ],
  lang: "en"
})
```

**Additional required field**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body.user.email` | string | Yes | Buyer's email for order confirmation |

Returns:
- `order_id` — UUID for tracking (use with `getOrderStatus`)
- `wallet_address` — crypto address to send payment to
- `coin_amount` — exact amount in payment currency
- `qr_url` — URL to QR code image for wallet scanning
- `qr_text` — payment URI (e.g., `bitcoin:3EFu...?amount=0.00038`)
- `payment_state` — initial state: `WalletCreated` or `PaymentRequested`
- `order_state` — initial state: `WaitingForPayment`

### getOrderStatus

Poll order progress and retrieve delivery details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `order_id` | string | Yes | Order ID from `createOrder` |

Returns:
- `payment_state` — `WalletCreated` → `PaymentRequested` → `PaymentReceived` (or `Expired`)
- `order_state` — `WaitingForPayment` → `Done` (success) / `Expired` / `Canceled` / `WaitingForManualAction`
- `deliveries[]` — when `order_state` is `Done`, each delivery contains:
  - `deliverable.pin_code` — gift card code or redemption URL
  - `deliverable.beneficiary_account` — delivery destination
  - `delivery_state` — `Created` → `Completed`
