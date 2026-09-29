# Bluvfi — Build with CMC: API Hackathon Submission

Bluvfi is an AI financial assistant for Web3 workers: pay bills, invest in stocks and pre-IPO deals, and stake idle balances for yield — all gasless with USDC. CoinMarketCap powers the live price ticker on the dashboard and the AI agent's market-data tools.

## Links

- **Repository:** https://github.com/HIVEPOD-SOLUTIONS/bottie-beta
- **Deployed app:** https://bluvfi.xyz
- **Demo video:** https://x.com/bluvfi/status/2097352616275517776
- **X post:** https://x.com/Jwafo_tweet/status/2104919554572853710
- **Track:** AI Agents & Automation

## CMC API endpoints used

| Endpoint | Used for | Code |
|---|---|---|
| `GET /v1/cryptocurrency/quotes/latest` | Dashboard price ticker (BTC, ETH, SOL, XRP) | `src/lib/coinmarketcap.ts` |
| `GET /v3/cryptocurrency/quotes/latest` | AI agent tool `get_crypto_prices` | `src/lib/ai/cmc-tools.ts` |
| `GET /v1/global-metrics/quotes/latest` | AI agent tool `get_crypto_market_overview` | `src/lib/ai/cmc-tools.ts` |
| `GET /v3/cryptocurrency/listings/latest` | AI agent tools `get_crypto_market_overview`, `get_top_movers` | `src/lib/ai/cmc-tools.ts` |
| `GET /v1/cryptocurrency/trending/latest` | AI agent tool `get_trending_crypto` (Startup plan+) | `src/lib/ai/cmc-tools.ts` |
| `GET /v2/tools/price-conversion` | AI agent tool `convert_crypto` | `src/lib/ai/cmc-tools.ts` |

## Evidence of a real API call

### Code (`src/lib/coinmarketcap.ts`)

```ts
const res = await fetch(url, {
  // Header, not the query param, so the key never lands in URLs or logs.
  headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
  cache: "no-store",
  signal: AbortSignal.timeout(8_000),
});

// Dashboard ticker
const body = await cmcRequest("/v1/cryptocurrency/quotes/latest", {
  id: TRACKED_COINS.map((c) => c.id).join(","), // 1,1027,5426,52
  convert: "USD",
});
```

### Request

```
GET https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=1,1027,5426,52&convert=USD
X-CMC_PRO_API_KEY: <redacted>
```

### Response (live call, 2026-09-29, trimmed to BTC and ETH)

```json
{
  "status": {
    "timestamp": "2026-09-29T13:05:20.823Z",
    "error_code": 0,
    "error_message": null,
    "credit_count": 1
  },
  "data": {
    "1": {
      "id": 1, "name": "Bitcoin", "symbol": "BTC",
      "quote": { "USD": {
        "price": 84262.19546061862,
        "percent_change_24h": 1.04998546,
        "market_cap": 1692903005730.9607,
        "last_updated": "2026-09-29T13:04:01.000Z"
      } }
    },
    "1027": {
      "id": 1027, "name": "Ethereum", "symbol": "ETH",
      "quote": { "USD": {
        "price": 2736.6543938423906,
        "percent_change_24h": 1.93840946,
        "market_cap": 334118656857.7551,
        "last_updated": "2026-09-29T13:04:01.000Z"
      } }
    }
  }
}
```

Same call returned SOL at $120.82 and XRP at $1.55.

## What the API made possible

- **Live prices without running our own indexer.** One call covers all four tracked coins, so a single cached request serves every user on the dashboard.
- **An AI agent that can answer market questions.** Users ask "what's moving today?" or "convert 0.5 ETH to USDC" in chat, and the agent calls CMC listings, global metrics, trending and price-conversion endpoints to answer with real data.
- **Stable coin identity.** CMC ids (1, 1027, 5426, 52) don't break on rebrands the way symbols can.

## Where it got in the way

- **Inconsistent error format.** v3 returns `error_code` as a string (`"1001"`), v1/v2 as a number, and an unknown path comes back as HTTP 200 with `error_code "500"`. We had to judge success from the status object, not the HTTP code.
- **WebSocket is paid-only.** Streaming needs the Startup plan, bills per message and can't be opened from a browser (the key goes in a custom header). On serverless hosting we fell back to REST polling with a 60s cache, which matches CMC's ~60s refresh anyway.
- **Plan-gated endpoints.** `trending/latest` returns 403 on the free plan, so the agent has to explain that gracefully instead of failing.
- **Credit limits.** Chat users repeat questions often, so we added an in-memory cache and shared in-flight requests to avoid burning credits on identical calls.
