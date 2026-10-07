/**
 * Runs every suite in this folder (*.test.cjs), one after another, and prints one line per suite plus the failures.
 * Exits non-zero if any suite fails or crashes, so it can gate a deploy.
 *
 *     npm test                         every suite
 *     npm test -- shar admin           only suites whose file name contains one of those words
 *
 * Needs PGlite once (an in-memory Postgres; see README.md). The real-database race test (concurrency.test.cjs) runs here in
 * its smoke mode; point RACE_DATABASE_URL at a throwaway database to run it for real.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = __dirname;
const filters = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.cjs") && (filters.length === 0 || filters.some((w) => f.includes(w)))).sort();
if (files.length === 0) {
  console.error(`No suites match ${filters.join(", ")}`);
  process.exit(2);
}

const rows = [];
let missingPglite = false;
for (const file of files) {
  const env = { ...process.env, TZ: "UTC" }; // Neon runs in UTC; see _harness.cjs
  if (file === "concurrency.test.cjs" && !env.RACE_DATABASE_URL) env.RACE_DATABASE_URL = "pglite";
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(dir, file)], { env, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 10 * 60_000 });
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const counts = /(\d+) passed, (\d+) failed/.exec(output);
  const skipped = !counts && /^SKIP/m.test(output);
  if (/Missing @electric-sql\/pglite/.test(output)) missingPglite = true;
  const failed = counts ? Number(counts[2]) : 0;
  const ok = run.status === 0 && (skipped || (counts && failed === 0));
  rows.push({
    file: file.replace(".test.cjs", ""),
    status: skipped ? "skipped" : ok ? "ok" : "FAILED",
    passed: counts ? Number(counts[1]) : 0,
    failed,
    seconds: ((Date.now() - started) / 1000).toFixed(1),
    problems: ok ? [] : output.split("\n").filter((l) => /^FAIL|CRASH|ERROR|Error:|unstubbed|REFUSING/.test(l)).slice(0, 8),
  });
}

const width = Math.max(...rows.map((r) => r.file.length));
console.log("");
for (const r of rows) console.log(`${r.status === "ok" ? "  ok     " : r.status === "skipped" ? "  skip   " : "  FAILED "}${r.file.padEnd(width)}  ${String(r.passed).padStart(4)} passed${r.failed ? `, ${r.failed} failed` : ""}  (${r.seconds}s)`);
const bad = rows.filter((r) => r.status === "FAILED");
for (const r of bad) {
  console.log(`\n${r.file}:`);
  for (const line of r.problems) console.log(`  ${line.slice(0, 200)}`);
}
if (missingPglite) console.log("\nPGlite is missing. Run once:  npm i --no-save @electric-sql/pglite   (or set PGLITE_PATH to a folder that has it)");
const total = rows.reduce((n, r) => n + r.passed, 0);
console.log(`\n${rows.length - bad.length}/${rows.length} suites ok, ${total} checks passed${bad.length ? `, ${bad.length} suite(s) FAILED` : ""}`);
process.exit(bad.length ? 1 : 0);
