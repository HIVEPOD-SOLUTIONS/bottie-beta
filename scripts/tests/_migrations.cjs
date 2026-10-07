/**
 * The migrations the Shar / provider-network code needs, as individual SQL statements in the order they must run.
 * Every test that builds a database from scratch uses this, so adding a migration here updates all of them at once.
 */
const fs = require("fs");
const path = require("path");

const FILES = ["0007_shar_rewards.sql", "0008_payouts_credits.sql", "0009_x402_edge.sql", "0010_listing_management.sql", "0011_abuse_controls.sql", "0012_provider_publishers.sql", "0013_provider_config.sql", "0014_provider_terms.sql", "0015_provider_creators.sql"];

const statements = FILES.flatMap((file) =>
  fs
    .readFileSync(path.join(__dirname, "../../drizzle", file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean),
);

module.exports = { FILES, statements };
