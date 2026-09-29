/**
 * Applies drizzle/0006_stocks.sql (stock_balances, stock_ledger, stock_orders)
 * to the database in DATABASE_URL. Idempotent: creates only what's missing,
 * so it runs on every Amplify build (see amplify.yml) and is safe by hand too.
 *
 * Why not `drizzle-kit migrate`: this project's drizzle.__drizzle_migrations
 * history is incomplete (earlier tables were created with `drizzle-kit push`),
 * so `migrate` would try to re-create existing tables and fail.
 *
 *   Dev (uses .env):  node --env-file=.env scripts/apply-stocks-migration.mjs
 *   Any database:     DATABASE_URL=... node scripts/apply-stocks-migration.mjs
 *
 * Exits non-zero on anything unexpected, which fails the build — better than
 * deploying code whose tables don't exist.
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[stocks-migration] DATABASE_URL is not set.");
  process.exit(1);
}
const sql = neon(url);
const host = new URL(url).host;

/** `drizzle-kit push` creates the tables but not this CHECK (it lives only in the SQL file). */
async function ensureNonNegative() {
  const found = await sql`SELECT 1 FROM pg_constraint WHERE conname = 'stock_balances_non_negative'`;
  if (found.length) return false;
  await sql`ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_non_negative" CHECK ("amount" >= 0)`;
  return true;
}

const existing = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('stock_balances', 'stock_ledger', 'stock_orders')`;

if (existing.length === 3) {
  const added = await ensureNonNegative();
  console.log(`[stocks-migration] ✓ ${host}: stock tables already exist${added ? " — added the non-negative balance check" : " — nothing to do"}.`);
  process.exit(0);
}
if (existing.length > 0) {
  console.error(`[stocks-migration] ✗ ${host}: only some stock tables exist (${existing.map((t) => t.table_name).join(", ")}). Fix manually, then rebuild.`);
  process.exit(1);
}

const statements = readFileSync(new URL("../drizzle/0006_stocks.sql", import.meta.url), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

// One transaction: either every table, index and constraint is created, or nothing is.
await sql.transaction(statements.map((s) => sql.query(s)));

const after = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name LIKE 'stock_%' ORDER BY 1`;
console.log(`[stocks-migration] ✓ ${host}: created ${after.map((t) => t.table_name).join(", ")}`);
