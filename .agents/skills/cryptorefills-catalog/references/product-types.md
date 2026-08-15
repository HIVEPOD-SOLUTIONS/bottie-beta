# Product Types

Cryptorefills offers three product types across 10,500+ brands and 180+ countries.

## Gift Cards

Digital gift card codes delivered via email. Redeemable at the brand's website or store.

- **Region-locked**: Each card is tied to a specific country (e.g., Amazon.com for US vs Amazon.it for Italy)
- **Denominations**: Fixed values (e.g., $25, $50, $100) or range-based (any amount within min/max)
- **Delivery**: Code sent to the provided email address
- **Redemption**: Enter code on brand's website or app. Codes starting with `http`/`https` require browser navigation; plain text codes are entered manually
- **Categories**: `e-commerce`, `food`, `games`, `entertainment`, `streaming`, `apparel_clothing`, `health_beauty`, `travel_flights`, `retail`, `electronics`, `sports_fitness`, `home`, `e-money`, `groceries`, and more

### Fixed vs Range Products

| Type | How it works | Example |
|------|-------------|---------|
| Fixed | Select from predefined denominations | Steam $10, $25, $50 |
| Range | Specify any amount between min and max | Amazon.com $1–$500 |

Range products are identified by the `is_dynamic` flag in product listings. When `is_dynamic` is true, the product has `min_value` and `max_value` fields instead of a fixed denomination list.

## Mobile Recharge

Prepaid airtime or data applied directly to a phone number. No code to redeem — the balance is added automatically.

- **Delivery**: Applied directly to the phone number (delivery type: phone)
- **Phone format**: E.164 required — `+` followed by country code and number (e.g., `+393401234567` for Italy)
- **Coverage**: 180+ countries, thousands of carriers
- **Categories**:
  - `mobile_talk_time` — Standard voice/SMS airtime credit
  - `mobile_credits` — Mobile credit and data packages
  - `mobile_bundle` — Combined voice + data + SMS bundles
- **Verified carriers**: Claro, Vivo, TIM, Algar Telecom (BR), and many more per country
- **Processing**: Usually applied within minutes

## eSIMs

Data-only travel SIM plans delivered as QR codes via email.

- **Category**: `e-sim`
- **Brand name in API**: `eSIM` (single brand with many denominations)
- **Delivery**: QR code and activation instructions via email
- **Coverage**: 180+ country and regional plans (Europe, Asia, Americas, Global)
- **Data caps**: Range from 1 GB to unlimited
- **Validity**: 1, 7, 15, or 30 days
- **Activation**: Scan QR code on compatible device (iPhone XS+ or recent Android with eSIM support)
- **Data-only**: No voice or SMS — use VoIP apps for calls
- **Regional plans**: Single eSIM covering multiple countries (e.g., "Europe 30 countries")

## Key Differences from Competitors

- **Range-based pricing**: Customers choose exact amounts within min/max bounds, not just fixed tiers
- **10,500+ brands**: Significantly broader catalog than alternatives
- **Multi-language**: Product descriptions available in 10 languages
- **MCP-native access**: Search and browse programmatically without screen scraping or CLI tools
