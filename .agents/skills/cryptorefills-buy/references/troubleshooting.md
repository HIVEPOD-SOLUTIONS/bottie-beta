# Troubleshooting

Common errors and fixes for Cryptorefills MCP purchases.

## Validation Errors

### Invalid Phone Number
**Error**: Phone number validation failed
**Cause**: Number not in E.164 format
**Fix**: Format as `+` followed by country code and number, no spaces or dashes

| Wrong | Correct |
|-------|---------|
| `0340 123 4567` | `+393401234567` |
| `(555) 123-4567` | `+15551234567` |
| `07911 123456` | `+447911123456` |

### Amount Out of Range
**Error**: Amount outside min/max for range product
**Cause**: Requested amount below `min_value` or above `max_value`
**Fix**: Check product's `min_value` and `max_value` from `listProductsForCountry` or `searchProducts`. Choose an amount within bounds.

### Product Not Available
**Error**: Product not found or not available in country
**Cause**: Product doesn't exist in the specified country's catalog
**Fix**: Search again with correct `country_code` (uppercase for MCP). Products are region-locked.

### Out of Stock
**Error**: Product temporarily unavailable
**Cause**: Inventory depleted
**Fix**: Try a different denomination, or check back later.

### Minimum Order Amount
**Error**: Order does not meet minimum amount
**Cause**: Total order value too low
**Fix**: Increase denomination or add more items to the cart.

## Order Creation Errors

### Invalid Product ID
**Error**: Product ID not recognized
**Cause**: Using an outdated or incorrect product ID
**Fix**: Re-search with `searchProducts` to get current product IDs.

### Payment Method Not Available
**Error**: Selected payment method unavailable
**Cause**: Currency or payment method suspended, or not supported for this product
**Fix**: Call `getCurrencies` to check current availability. Try a different payment method.

### Denomination Mismatch
**Error**: Selected denomination not available for product
**Cause**: Fixed-denomination product and the value doesn't match any available option
**Fix**: Check product details for available denominations. For fixed products, use the exact value from the denomination list. For range products (`is_dynamic: true`), use any value within `min_value`–`max_value`.

## Payment Errors

### Underpayment
**Symptom**: Payment sent but order stays in `WaitingForPayment`
**Cause**: Sent less crypto than required
**Recovery**: If payment window still open, send the remaining amount to the same address. If expired, create a new order and email support@cryptorefills.com with the transaction hash for a partial refund.

### Overpayment
**Symptom**: Order fulfilled but excess amount sent
**Cause**: Sent more crypto than the exact amount required
**Recovery**: Order completes normally. Email support@cryptorefills.com with transaction hash and order ID to request refund of the overage.

### Payment After Expiration
**Symptom**: Payment sent but order is `Expired`
**Cause**: Payment arrived after the order window closed
**Recovery**: Create a new order for the next attempt. Email support@cryptorefills.com with the transaction hash of the expired payment for a refund.

### Wrong Network
**Symptom**: Transaction confirmed on-chain but Cryptorefills doesn't see it
**Cause**: Sent to wrong blockchain network (e.g., USDC on Ethereum instead of Polygon)
**Recovery**: Create a new order on the correct network. Email support@cryptorefills.com with the transaction hash — recovery depends on the chain and may not be possible.

## MCP Connection Errors

### Missing User-Agent Header
**Error**: Request rejected
**Fix**: Ensure `User-Agent: Cryptorefills-MCP/1.0` header is set. In Claude Code MCP settings:
```json
{ "headers": { "User-Agent": "Cryptorefills-MCP/1.0" } }
```

### Server Timeout
**Error**: MCP request times out
**Fix**: Retry after a few seconds. If persistent, check Cryptorefills status.

### Rate Limiting
**Error**: Too many requests
**Fix**: Back off with exponential delay. Space out catalog queries.

## Search Issues

### Empty Results
**Cause**: Brand not available in the specified country, or query too specific
**Fix**: Try broader search terms, different country, or browse with `listBrands`.

### Wrong Language
**Cause**: Using `language` instead of the correct parameter name `lang`, or using an unsupported language code
**Fix**: Use the parameter `lang` with one of: `en`, `es`, `fr`, `de`, `it`, `pt`, `zh`, `tr`, `vi`, `tl`.

## Purchase Elicitation Issues

### Session Expired
**Cause**: Too long between elicitation steps (sessions expire after ~10 minutes of inactivity)
**Fix**: Start a new session with empty `{}` call.

### Back Navigation
**Cause**: User changed their mind on a previous answer
**Fix**: Send `action: "back"` with the `session_token` to revert one step.
