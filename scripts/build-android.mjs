/**
 * build-android.mjs
 *
 * Builds a fully-static Next.js export for the Capacitor Android APK.
 *
 * Why individual file renames, not directory rename?
 * ──────────────────────────────────────────────────
 * • `renameSync(dir, dirBak)` → EPERM on Windows when VS Code has the
 *   directory open with ReadDirectoryChangesW.
 * • `renameSync(file, file+'.bak')` → works fine: VS Code's directory handle
 *   does NOT prevent renaming individual files within that directory.
 *
 * Why not patch source files?
 * ───────────────────────────
 * Next.js's route-handler module wrapper strips `generateStaticParams` from
 * API routes (it's only valid on page routes).  Even when we inject it into
 * the TypeScript source, the compiled route-handler module doesn't expose it,
 * so the static-export validator always errors.
 *
 * Solution: hide every route.ts / route.tsx inside src/app/api/ by renaming
 * it to .android.bak.  Next.js's filesystem scanner only looks for the exact
 * filenames `route.ts` / `route.tsx`, so the API routes become invisible.
 * After the build (success or failure) we rename everything back.
 */

import { readdirSync, renameSync, existsSync, rmSync } from "node:fs";
import { execSync }                                      from "node:child_process";
import { join, resolve }                                 from "node:path";
import { fileURLToPath }                                 from "node:url";

const root   = resolve(fileURLToPath(import.meta.url), "../..");
const apiDir = join(root, "src/app/api");

// ── Collect all route.ts / route.tsx under src/app/api ───────────────────────
function findRouteFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findRouteFiles(full));
    } else if (/^route\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ── Sanity-check for leftover .bak files from a crashed previous run ─────────
const testBak = findRouteFiles(apiDir.replace(/api$/, ""))
  .filter(f => f.endsWith(".android.bak"));
if (testBak.length > 0) {
  console.warn(`⚠   Found ${testBak.length} leftover .android.bak files from a previous run.`);
  console.warn("    Restoring them before proceeding…");
  for (const bak of testBak) {
    renameSync(bak, bak.replace(/\.android\.bak$/, ""));
  }
}

const routeFiles = findRouteFiles(apiDir);
console.log(`\n📦  Hiding ${routeFiles.length} API route files from Next.js scanner…`);

// ── Rename route files → .android.bak ────────────────────────────────────────
const renames = []; // { original, backup }
for (const file of routeFiles) {
  const backup = file + ".android.bak";
  renameSync(file, backup);          // rename FILE (not directory) — no EPERM
  renames.push({ original: file, backup });
}
console.log(`    Done — Next.js will see no API routes during this build.\n`);

// ── Clear webpack cache (force full recompile) ────────────────────────────────
const wpCache = join(root, ".next", "cache", "webpack");
if (existsSync(wpCache)) {
  console.log("🗑   Clearing webpack cache…");
  rmSync(wpCache, { recursive: true, force: true });
}

// ── Build ─────────────────────────────────────────────────────────────────────
let exitCode = 0;
console.log("🏗   Building static export (this takes ~10-15 min)…\n");

try {
  execSync("dotenv -e .env.capacitor -- next build --webpack", {
    cwd:   root,
    stdio: "inherit",
    env:   { ...process.env, NEXT_EXPORT: "1" },
  });
  console.log("\n✅  Static export written to out/");
} catch {
  console.error("\n❌  Build failed — route files will still be restored.");
  exitCode = 1;
} finally {
  // ── Restore ───────────────────────────────────────────────────────────────
  console.log(`\n🔄  Restoring ${renames.length} route files…`);
  for (const { original, backup } of renames) {
    renameSync(backup, original);
  }
  console.log("✅  All files restored.\n");
}

process.exit(exitCode);
