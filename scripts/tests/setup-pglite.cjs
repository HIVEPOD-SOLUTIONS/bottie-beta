/**
 * Installs PGlite (the in-memory Postgres the suites run on) into scripts/tests/.deps, outside the project's node_modules, so reinstalling
 * the project's dependencies never removes it and package.json / the lockfiles never mention it. _harness.cjs looks there automatically,
 * and run-all.cjs runs this by itself the first time PGlite is missing.
 *
 *     npm run test:setup
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/** The version the suites are known to pass on. Change it here, then delete scripts/tests/.deps and run this again. */
const PGLITE_VERSION = "0.5.10";
const DEPS = path.join(__dirname, ".deps");

function installed() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DEPS, "node_modules/@electric-sql/pglite/package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function setupPglite() {
  if (installed() === PGLITE_VERSION) return true;
  fs.mkdirSync(DEPS, { recursive: true });
  // Its own tiny package.json, so npm installs here and never walks up to the project's.
  const pkg = path.join(DEPS, "package.json");
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: "bluvfi-test-deps", private: true }, null, 2) + "\n");
  console.log(`Installing @electric-sql/pglite@${PGLITE_VERSION} into scripts/tests/.deps (test-only, not a project dependency)…`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = spawnSync(npm, ["install", `@electric-sql/pglite@${PGLITE_VERSION}`, "--no-audit", "--no-fund", "--no-package-lock", "--save-exact"], {
    cwd: DEPS,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (run.status !== 0 || installed() !== PGLITE_VERSION) {
    console.error("Couldn't install PGlite. Check the network, or set PGLITE_PATH to a folder that already has it.");
    return false;
  }
  return true;
}

module.exports = { setupPglite, PGLITE_DIR: path.join(DEPS, "node_modules/@electric-sql/pglite") };

if (require.main === module) process.exit(setupPglite() ? 0 : 1);
