/**
 * Applies drizzle/0017_business.sql (Bluvfi for Business: business_accounts,
 * business_payees, business_bills, business_decisions) to the database in
 * DATABASE_URL. Idempotent: does nothing when all four tables exist, so it runs
 * on every Amplify build (see amplify.yml) and is safe by hand too.
 *
 * Why not `drizzle-kit migrate`: see scripts/apply-stocks-migration.mjs.
 *
 *   Dev (uses .env):  node --env-file=.env scripts/apply-business-migration.mjs
 *   Any database:     DATABASE_URL=... node scripts/apply-business-migration.mjs
 */
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[business-migration] DATABASE_URL is not set.");
  process.exit(1);
}
const sql = neon(url);
const host = new URL(url).host;
const TABLES = ["business_accounts", "business_payees", "business_bills", "business_decisions"];

// Columns added after the first release (Circle developer-controlled wallets).
// Idempotent, and run on every build so existing databases catch up.
async function upgrade() {
  await sql`ALTER TABLE "business_accounts" ADD COLUMN IF NOT EXISTS "custody" text DEFAULT 'local' NOT NULL`;
  await sql`ALTER TABLE "business_accounts" ADD COLUMN IF NOT EXISTS "circle_wallet_id" text`;
  await sql`ALTER TABLE "business_accounts" ALTER COLUMN "encrypted_key" DROP NOT NULL`;
  await sql`ALTER TABLE "business_bills" ADD COLUMN IF NOT EXISTS "payment_key" text`;
  await sql`ALTER TABLE "business_bills" ADD COLUMN IF NOT EXISTS "provider_tx_id" text`;
}

const existing = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = ANY(${TABLES})`;
if (existing.length === TABLES.length) {
  await upgrade();
  console.log(`[business-migration] ✓ ${host}: business tables up to date.`);
  process.exit(0);
}
if (existing.length > 0) {
  console.error(`[business-migration] ✗ ${host}: only some business tables exist (${existing.map((t) => t.table_name).join(", ")}). Fix manually, then rebuild.`);
  process.exit(1);
}

const statements = readFileSync(new URL("../drizzle/0017_business.sql", import.meta.url), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

// One transaction: every table and index, or nothing.
await sql.transaction(statements.map((s) => sql.query(s)));
await upgrade();
console.log(`[business-migration] ✓ ${host}: created ${TABLES.join(", ")}`);
