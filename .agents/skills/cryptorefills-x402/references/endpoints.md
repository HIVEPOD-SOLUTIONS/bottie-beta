# x402 REST API Reference

The same REST contract is served from two hosts. Pick by rail:

| Host | Default rail | Multi-rail? | Notes |
|---|---|---|---|
| `https://x402.cryptorefills.com` | Base | Yes — set `X-Preferred-Network: solana` to opt into Solana | Backward-compatible with EVM-only agents that don't send the header |
| `https://solana.x402.cryptorefills.com` | Solana | No — Solana only | `X-Preferred-Network` must be omitted or `solana`; any other value returns `400 invalid_network_for_host`. Used by registries that demand a Solana 402 challenge by default (e.g. pay-skills). |

Manifests:
- `https://x402.cryptorefills.com/.well-known/x402.json` — multi-rail
- `https://solana.x402.cryptorefills.com/.well-known/x402.json` — Solana-only

When verifying `payTo` against a manifest, always read the manifest **at the same host** you sent Phase 1 to — the two hosts publish different deposit wallets.

## GET /v1/brands

Discover brands available in a country.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country_code` | string (query) | Yes | Lowercase ISO 3166-1 Alpha-2 (e.g., `us`, `it`, `br`) |

**Response** (200): Array of brand objects.

| Field | Description |
|-------|-------------|
| `brand_name` | Brand identifier — use in `/v1/catalog` queries |
| `family` | Brand name (e.g., "Amazon.com", "Steam", "eSIM") |
| `category` | Product category (e.g., "e-commerce", "gaming", "food") |
| `min` | Minimum denomination (informational) |
| `max` | Maximum denomination (informational) |

**Example**:
```http
GET /v1/brands?country_code=us
```

## GET /v1/catalog

Get products and pricing for a specific brand.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country_code` | string (query) | Yes | Lowercase ISO 3166-1 Alpha-2 |
| `brand_name` | string (query) | Conditional | Brand name from `/v1/brands`. At least one of `brand_name` or `family_name` required |
| `family_name` | string (query) | Conditional | Filter by brand name (from `/v1/brands` `family` field) |

**Response** (200): Array of product objects.

| Field | Description |
|-------|-------------|
| `product_id` | Use in `items[].product_id` when ordering |
| `product_name` | Human-readable name |
| `brand_name` | Brand identifier |
| `is_range` | Boolean. **If `true`, you MUST send `items[].product_value` at order time.** If `false`, the product is fixed-denomination — omit `product_value`. |
| `currency` | The **brand's local currency code** (e.g. `"USD"`, `"EUR"`, `"GBP"`). `product_value`, `min_value`, and `max_value` are all in this currency. |
| `denomination` | Fixed face value (e.g. `"25"`). Null for range products. In `currency` units. |
| `denomination_label` | Short human label (`"$25"`, `"€5 – €500"`, `"100 Diamonds"`). |
| `face_value_usd` | Optional USD-equivalent of the face value. |
| `min_value` | Minimum allowed `product_value` for range products. In `currency` units. |
| `max_value` | Maximum allowed `product_value` for range products. In `currency` units. |
| `price_usdc` | Indicative USDC price (actual amount confirmed in 402, on whichever rail you settle). |
| `country_code` | The product's country, lowercase ISO 3166-1 Alpha-2. |
| `type` | Product type (e.g. `"gift_card"`, `"topup"`, `"esim"`). |

**Example**:
```http
GET /v1/catalog?country_code=us&brand_name=Amazon.com
```

## POST /v1/orders

Two-phase order endpoint.

### Phase 1: Get Payment Requirements

Send order without `PAYMENT-SIGNATURE` header.

**Request headers**:

| Header | Required | Notes |
|---|---|---|
| `Content-Type: application/json` | Yes | |
| `X-Preferred-Network` | No | `base` (default) or `solana`. On the Solana-only host, must be omitted or `solana`. |

**Request body**:
```json
{
  "email": "delivery@example.com",
  "items": [
    {
      "product_id": "abc123",
      "beneficiary_account": "recipient@example.com",
      "product_value": 25
    }
  ],
  "callback_url": "https://example.com/webhook"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Contact email for the order |
| `items` | array | Yes | Products to purchase |
| `items[].product_id` | string | Yes | From `/v1/catalog` |
| `items[].beneficiary_account` | string | Yes | Email or account to receive the voucher |
| `items[].product_value` | number | Conditional | Required when the catalog product has `is_range: true`. **In the brand's local `currency`, not USD** (e.g. `5` for a €5 Amazon.nl card, not its USD equivalent). The 402 response then quotes the USDC amount to settle. |
| `callback_url` | string | No | Webhook URL for order state notifications |

**Response** (402):

| Header | Notes |
|---|---|
| `PAYMENT-REQUIRED` | base64url-encoded JSON. See `protocol.md` for per-rail shape. |
| `X-Session-Id` | UUID. **Echo this on Phase 2 — required for Solana, optional for Base.** |

### Phase 2: Submit Payment

Re-send the same request body with the `PAYMENT-SIGNATURE` header.

**Request headers**:

| Header | Required | Notes |
|---|---|---|
| `Content-Type: application/json` | Yes | |
| `PAYMENT-SIGNATURE` | Yes | base64url-encoded JSON wrapping the per-rail signed payload (see `protocol.md`). |
| `X-Session-Id` | Required for Solana, optional for Base | Echo verbatim from Phase 1 response. Base falls back to `authorization.to` lookup if absent. |

**Response** (200):
```json
{
  "order_id": "cr_abc123",
  "status": "processing",
  "email": "delivery@example.com",
  "estimated_delivery_seconds": 60,
  "poll_url": "/v1/orders/cr_abc123",
  "deliveries": []
}
```

| Field | Description |
|-------|-------------|
| `order_id` | Unique order identifier |
| `status` | `processing`, `completed`, `failed`, `expired` |
| `estimated_delivery_seconds` | Typical delivery time |
| `poll_url` | Path to check order status |
| `deliveries` | Array of delivered items (empty initially) |

## GET /v1/orders/{order_id}

Poll for order status and voucher delivery.

**Response** (200):
```json
{
  "order_id": "cr_abc123",
  "status": "completed",
  "deliveries": [
    {
      "delivery_state": "completed",
      "brand_name": "Amazon.com",
      "product_name": "Amazon $25",
      "voucher_code": "XXXX-YYYY-ZZZZ",
      "pin": "1234",
      "url": "https://www.amazon.com/gc/redeem"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `status` | `processing` → `completed` or `failed` or `expired` |
| `deliveries[].delivery_state` | `pending`, `completed`, `failed` |
| `deliveries[].voucher_code` | Gift card code |
| `deliveries[].pin` | PIN if required by the brand |
| `deliveries[].url` | Redemption URL if applicable |

**Polling**: Every 5–10 seconds until `status` is `completed` or `failed`.

## Error Responses

| Status | Code / message | Meaning |
|--------|---------|---------|
| 400 | — | Bad request — invalid body, missing required fields |
| 400 | `invalid_network_for_host` | Sent `X-Preferred-Network: base` (or anything ≠ `solana`) to `solana.x402.cryptorefills.com`. Drop the header or set it to `solana`, or use the bare `x402.cryptorefills.com` host. |
| 400 | `invalid_network` | Unknown value in `X-Preferred-Network`. Allowed: `base`, `solana`. |
| 402 | — | Payment required — normal Phase 1 response |
| 403 | — | Forbidden — invalid or expired payment signature |
| 404 | — | Order or product not found |
| 422 | — | Validation failed — invalid `product_id`, amount out of range |
| 500 | — | Server error — retry after a delay |
| 502 | `upstream_error` | Cryptorefills core API unavailable. |
| 503 | `facilitator_unavailable` | Payment facilitator temporarily unavailable. Honour the `Retry-After` header. |
| 503 | Solana settlement temporarily unavailable | CDP `/supported` discovery failure on Phase 1. **Pre-flight only — no order is created.** Retry after ~30 s, or fall back to Base. |
