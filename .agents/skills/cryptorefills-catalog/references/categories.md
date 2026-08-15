# Categories & Brands

Product taxonomy on Cryptorefills. Categories are dynamic — verify availability via MCP tools for the user's country.

## Category Slugs

These are the actual `category` values returned by the API. Use them for filtering.

| Category Slug | Description |
|---------------|-------------|
| `e-commerce` | Online marketplaces and retailers |
| `retail` | Physical and general retail stores |
| `electronics` | Tech and electronics brands |
| `food` | Restaurants, food delivery, dining |
| `groceries` | Supermarkets and grocery chains |
| `games` | Gaming platforms, in-game currencies |
| `entertainment` | Movies, events, experiences |
| `streaming` | Music and video streaming services |
| `apparel_clothing` | Fashion, shoes, accessories |
| `health_beauty` | Cosmetics, wellness, pharmacy |
| `sports_fitness` | Sporting goods and fitness |
| `travel_flights` | Travel, flights, accommodation |
| `home` | Home goods and furnishings |
| `e-money` | Digital wallets, payment vouchers, prepaid cards |
| `e-sim` | Data-only travel eSIM plans |
| `mobile_talk_time` | Prepaid voice/SMS airtime |
| `mobile_credits` | Mobile credit and data packages |
| `mobile_bundle` | Combined voice + data + SMS bundles |
| `charity_donations` | Donation gift cards |
| `other_products` | Miscellaneous products |

## Verified Brands by Category (US)

Based on live API data. Availability varies by country.

| Category | Verified Brands |
|----------|----------------|
| `e-commerce` | Amazon.com, eBay, Etsy, Overstock.com, Groupon |
| `retail` | Walmart, Best Buy, IKEA, Target |
| `electronics` | Everything Apple, Razer Gold USD, Best Buy |
| `food` | Dominos, Applebee's, DoorDash |
| `games` | Steam, PlayStation Store, Xbox, Nintendo eShop, Roblox, Fortnite, Google Play |
| `entertainment` | Fandango, StubHub |
| `streaming` | Spotify, Netflix |
| `apparel_clothing` | Nike, Asos, Guess, Aerie, Zappos, ThredUP, Stitch Fix |
| `sports_fitness` | Fanatics, MLB Shop, NHL Shop, NFLshop com |
| `e-money` | Tango, GCodes Global Everything, PCS Mastercard |
| `e-sim` | eSIM |
| `home` | Wayfair, allmodern.com, jossandmain.com, Birchlane.com |
| `health_beauty` | Soothe, Shutterfly |

## Verified Brands by Category (IT)

| Category | Verified Brands |
|----------|----------------|
| `e-commerce` | Amazon.it, Zalando, Bol.com |
| `electronics` | Unieuro, Trony, Cyberport |
| `games` | Steam, PlayStation Store, Xbox, Nintendo eShop, Roblox, Valorant Point (VP), EA, eneba, GameStop |
| `apparel_clothing` | Asos, Guess, Bottega Verde, Piquadro.Com, Forzieri |
| `e-money` | PCS Mastercard |
| `e-sim` | eSIM |
| `retail` | IKEA |
| `food` | Tannico.it |

## Verified Brands by Category (BR)

| Category | Verified Brands |
|----------|----------------|
| `e-commerce` | Shopee, Americanas, Extra.com.br, Casabahia.com |
| `games` | Steam, PlayStation Store, Xbox, Roblox, Free Fire, Fortnite, Google Play, PUBG Mobile |
| `apparel_clothing` | Nike, Renner, Havaianas, Arezzo, Centauro |
| `streaming` | Spotify, Netflix |
| `food` | Rappi, Zé Delivery, Applebee's, Outback |
| `mobile_credits` | Claro, Vivo, TIM, Algar Telecom |
| `travel_flights` | Airbnb, Uber, FlixBus, Buser |
| `e-sim` | eSIM |

## The `family` Field

The `family` field in API responses is the **brand name** (e.g., "Amazon.com", "Steam", "eSIM"), not a product type. Multiple products from the same brand share a `family` value. Use it to group denominations for the same brand.

## Discovering Categories Dynamically

The category tables above are snapshots. To discover current categories at runtime:

1. Call `listBrands(country_code="XX")`
2. Collect unique `category` values from the response
3. Group brands by category to show the user what's available

This is more reliable than using the static list above, as categories may change when new brands are added.

## Notes

- Categories and brand availability vary by country
- New brands are added regularly — always query the live catalog
- Brand names are case-sensitive — use exact values from `listBrands` response
- A single brand may appear multiple times in results with different denominations
