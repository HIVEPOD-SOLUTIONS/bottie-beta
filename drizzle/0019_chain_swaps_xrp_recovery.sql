-- XRP top-ups: XRPL is now a chain_swaps chain (it tops up the Bluvfi wallet on Base for Cryptorefills, Backpack stocks and Doma,
-- like Arc, Tempo, Robinhood Chain, Zcash and Hyperliquid). Unlike those, a failed XRP swap is not refunded on-chain: its XRP stays in
-- the swap wallet bluvfi-xrpl holds and is recovered to the user's Bluvfi XRP wallet. recovered_at marks that it was, so the same XRP
-- is never offered for recovery twice. Applied by hand (Neon SQL editor). Safe to run twice. Needs 0016_chain_swaps.sql first.
-- Run it BEFORE deploying the code that reads it (recoverable XRP lists select this column).

ALTER TABLE "chain_swaps" ADD COLUMN IF NOT EXISTS "recovered_at" timestamp;
