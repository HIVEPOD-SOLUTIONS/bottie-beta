/**
 * One-time setup for Circle developer-controlled wallets (Bluvfi for Business
 * treasuries). Run it yourself, on your own machine — it handles secrets:
 *
 *   node --env-file=.env scripts/circle-setup.mjs
 *
 * Needs CIRCLE_API_KEY in .env (Circle Console → Keys → create an API key).
 *
 * It generates a new 32-byte entity secret, registers it with Circle, saves
 * Circle's RECOVERY FILE next to this repo (outside git), and appends
 * CIRCLE_ENTITY_SECRET to .env. Then copy both CIRCLE_API_KEY and
 * CIRCLE_ENTITY_SECRET into Amplify's environment variables.
 *
 * Keep the entity secret AND the recovery file safe (e.g. a password manager):
 * with them, Circle lets you recover wallets; lose both and the treasuries'
 * funds can't be moved. Circle does not store the entity secret.
 *
 * If CIRCLE_ENTITY_SECRET is already set, it does nothing (registering a second
 * secret would replace the first).
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey) {
  console.error("✗ CIRCLE_API_KEY is not set. Create one in the Circle Console (Keys), add it to .env, then run this again.");
  process.exit(1);
}
if (process.env.CIRCLE_ENTITY_SECRET) {
  console.log("✓ CIRCLE_ENTITY_SECRET is already set — nothing to do. (Never register a second one unless you mean to rotate it.)");
  process.exit(0);
}

const entitySecret = randomBytes(32).toString("hex");
const dir = "../circle-recovery"; // next to the repo, never inside it
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

try {
  await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: dir });
} catch (err) {
  const e = err;
  console.error("✗ Circle refused the registration:", e?.response?.data?.message ?? e?.message ?? e);
  process.exit(1);
}

appendFileSync(".env", `\n# Circle developer-controlled wallets (Bluvfi for Business). Also set in Amplify. Back it up with the recovery file.\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);
console.log("✓ Entity secret registered with Circle and added to .env as CIRCLE_ENTITY_SECRET.");
console.log(`✓ Recovery file saved in ${dir} (outside the repo).`);
console.log("Next: copy CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET into Amplify → Environment variables, and back up both the secret and the recovery file.");
