# Tests

Plain Node scripts that run the **real code in `src/`** (TypeScript transpiled on the fly) against an **in-memory Postgres
(PGlite) built from the real migrations**. Nothing touches Neon, production, a real chain or real money. Auth, the rate
limiter, DNS and the chain are replaced by simulations; everything else is the code that ships.

```bash
npm test                      # every suite, one summary line each; exits non-zero if anything fails
npm test -- shar admin        # only suites whose file name contains one of these words
node scripts/tests/abuse.test.cjs      # one suite on its own
```

**One-time setup:** the suites need PGlite, which is deliberately *not* a project dependency (so builds and `package-lock.json`
stay untouched):

```bash
npm i --no-save @electric-sql/pglite      # or put it anywhere and set PGLITE_PATH=<that folder>
```

`pinned-request.test.cjs` also needs `openssl` on the PATH (it makes a throwaway certificate for a local TLS server) and skips
cleanly without it.

## What each suite covers

| Suite | What it proves |
| --- | --- |
| `payments-rules` | Money maths: micro-USDC/SKR integers, the 80/20 split, price and address rules |
| `shar-rules`, `shar` | Shar earning, tiers, weeks, the SKR rate, the full summary/claims/leaderboard flow, before-migration behaviour |
| `shar-claim`, `shar-referral` | Claiming (two taps at once = one claim) and the referral bonus (only spending after the code counts) |
| `network` | Provider listing validation, review, usage caps, the gateway's protections (DNS, redirects, size, rebinding) |
| `listing-management` | Owner edit / pause / resume / remove, the team's featured flag, search, filters, sorting, the detail page |
| `pinned-request` | The gateway's HTTPS transport against a real TLS server: pinned address, no DNS, certificate checks, caps, deadlines |
| `credits-gateway`, `topup` | Credits, paid calls (refund on any failure), 80/20 settlement, on-chain top-up verification (real mainnet fixtures) |
| `skr-payout`, `admin` | SKR payouts against a simulated chain (never twice, drift guard, limits) and the admin routes and audit trail |
| `abuse` | Linking accounts by phone and wallet, the per-phone claim limit, referrals/provider use between linked accounts, the acknowledgement before paying them |
| `x402` | x402 for outside agents: verify → provider → settle, replay, tampering, stuck payments, the facilitator's HTTP client |
| `ai-network` | The AI agent's Shar/network prompt (app only) and its three read-only tools |
| `solana-rpc-proxy` | `POST /api/solana/rpc`: who may call it, what it refuses, forwarding against a fake upstream |
| `admob-ssv` | Rewarded-ad verification: a callback Google itself signed, re-encodings, tampering, stale callbacks, key rotation |
| `concurrency` | Money paths under parallel requests (see below) |

## The real-database race test

`concurrency.test.cjs` fires many requests at once and checks nothing is double-spent. Through `npm test` it runs in **smoke
mode** on PGlite (which serialises everything, so it only proves the script works). For the real thing, give it a **throwaway**
Postgres (a fresh Neon branch is ideal); it uses the production driver, builds its own tables and drops them afterwards:

```bash
RACE_DATABASE_URL="postgresql://user:pass@host/db?sslmode=require" node scripts/tests/concurrency.test.cjs
```

It refuses to run if the database already has tables (so it can't be pointed at production by accident); `RACE_WIPE=1`
lets it drop its own leftover tables. Never put that URL in a file that is committed or shipped.

## Writing a suite

Copy a small one (`shar-rules.test.cjs`, `abuse.test.cjs`). `_harness.cjs` gives you `makeLoader(stubs)` (real source with the
imports you stub), `freshDb()` (PGlite with every migration) and `reporter()` (`check(name, ok, detail)` and `finish()`).
New migrations are registered in `_migrations.cjs`. Test real behaviour, including refusals and failures, not just the happy path.
The emulator backend for trying the app is in `scripts/e2e/`.
