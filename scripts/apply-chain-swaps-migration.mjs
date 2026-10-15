/**
 * Applies drizzle/0016_chain_swaps.sql (chain_swaps — the ledger of every
 * Zcash / Hyperliquid / Arc / Robinhood / Tempo payment, so nothing sent
 * through bluvfi-xrpl can go untracked) to the database in DATABASE_URL.
 * Idempotent: does nothing if the table exists, so it runs on every Amplify
 * build (see amplify.yml) and is safe by hand too.
 *
 * Also adds bitrefill_orders.invoice_access_token (ADD COLUMN IF NOT EXISTS),
 * which the server needs to confirm a Bitrefill order with Bitrefill itself.
 *
 * Why not `drizzle-kit migrate`: this project's drizzle.__drizzle_migrations
 * history is incomplete — see scripts/apply-stocks-migration.mjs.
 *
 *   Dev (uses .env):  node --env-file=.env scripts/apply-chain-swaps-migration.mjs
 *   Any database:     DATABASE_URL=... node scripts/apply-chain-swaps-migration.mjs
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[chain-swaps-migration] DATABASE_URL is not set.");
  process.exit(1);
}
const sql = neon(url);
const host = new URL(url).host;

// Column on an existing table: a no-op once it's there.
await sql`ALTER TABLE "bitrefill_orders" ADD COLUMN IF NOT EXISTS "invoice_access_token" text`;

const existing = await sql`
  SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chain_swaps'`;
if (existing.length) {
  console.log(`[chain-swaps-migration] ✓ ${host}: chain_swaps and bitrefill_orders.invoice_access_token are in place — nothing to do.`);
  process.exit(0);
}

const statements = readFileSync(new URL("../drizzle/0016_chain_swaps.sql", import.meta.url), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

// One transaction: the table and all its indexes, or nothing.
await sql.transaction(statements.map((s) => sql.query(s)));
console.log(`[chain-swaps-migration] ✓ ${host}: created chain_swaps`);
