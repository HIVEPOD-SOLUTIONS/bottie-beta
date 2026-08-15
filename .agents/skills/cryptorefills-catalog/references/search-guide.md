# Search & Discovery Guide

How to use the Cryptorefills MCP catalog tools effectively.

## searchProducts

Free-text product search. Best for finding a specific brand or narrowing by keyword.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country_code` | string | Yes | Uppercase ISO 3166-1 Alpha-2 (e.g., `US`, `DE`, `BR`) |
| `q` | string | Yes | Search query text (e.g., "Netflix", "Steam", "eSIM") |
| `lang` | string | No | Language code: en, es, fr, de, it, pt, zh, tr, vi, tl. Default: en |

**Important**: The parameter is `q` (not `query`) and `lang` (not `language`).

**When to use**: User asks for a specific brand or product by name.

**Example flow**:
```
searchProducts(country_code="US", q="Amazon", lang="en")
→ Returns matching products with IDs, denominations, prices
```

**Also available as direct HTTP**:
```
GET https://api.cryptorefills.com/v2/search/{country_code}?q={query}&lang={lang}
```

## listBrands

Browse all brands available in a country. Returns brand metadata grouped by category.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country_code` | string | Yes | Uppercase ISO 3166-1 Alpha-2 |
| `promo_code` | string | No | Promotional code for special offers |

**Response structure**: Categories array, each containing `brands` array with: `brand` (display name), `brand_id`, `family`, `category`, `min`, `max`, `kind` (giftcard/mobile_recharge), `is_out_of_stock`.

**Brand names may include suffixes**: e.g., "Claro Credits" not "Claro", "Vivo Credits" not "Vivo", "TIM Credits" not "TIM". Always use the exact `brand` value from the response.

**When to use**: User wants to browse what's available, explore categories, or doesn't know the exact brand name. This is the most reliable discovery tool.

## listProductsForCountry

Full product catalog for a country with detailed filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `country_code` | string | Yes | Uppercase ISO 3166-1 Alpha-2 |
| `brand_name` | string | No | Filter by brand name (e.g., `"Steam"`, `"Amazon.com"`, `"Claro Credits"`) — use values from `listBrands` response |
| `family_name` | string | No | Filter by brand family name (e.g., `"Amazon.com"`, `"Steam"`, `"eSIM"`) |
| `coin` | string | No | Filter by payment cryptocurrency |
| `payment_method` | string | No | Filter by payment method ID (e.g., `USER_WALLET`, `GATE_PAY`) |
| `lang` | string | No | Language code. Default: en |
| `promo_code` | string | No | Promotional code for special offers |

**Response includes**: Product IDs, denominations (fixed list or min/max range), `is_dynamic` flag, pricing.

**When to use**: Need comprehensive product listings, filtering by multiple criteria, or checking specific product details.

## getCurrencies

List all supported payment cryptocurrencies.

**No parameters required.**

**Response**: Array of currency objects with `name`, `logo_url`, `is_suspended`.

**When to use**: User asks what crypto they can pay with, or you need to verify a currency is active (not suspended) before quoting prices.

## getPaymentViasWithCurrencies

Payment methods with their supported currencies and blockchain networks.

**No parameters required.**

**Response**: Array of payment method objects with `name` (e.g., `USER_WALLET`, `GATE_PAY`, `KUCOIN_PAY`, `BUYDL`) and `currencies` array.

**When to use**: User asks about specific chains or payment routing. Use the `name` value as the `payment_method` parameter in `validateOrder` and `createOrder`.

## Search Strategy

Recommended approach based on user intent:

1. **Specific brand** → `searchProducts` with `q` parameter
2. **Category browsing** → `listBrands` then filter by `category`
3. **Full exploration** → `listProductsForCountry` with country only
4. **Cross-reference** → `searchProducts` first, then `listProductsForCountry` for full details on matches

Always confirm the user's country before searching — products are region-locked and results vary significantly by country.

## Multi-Language Support

Pass the `lang` parameter to get product names and descriptions in the user's preferred language.

| Code | Language |
|------|----------|
| `en` | English |
| `es` | Spanish |
| `fr` | French |
| `de` | German |
| `it` | Italian |
| `pt` | Portuguese |
| `zh` | Chinese |
| `tr` | Turkish |
| `vi` | Vietnamese |
| `tl` | Filipino |

If the requested language is unavailable for a product, the server falls back to English.
