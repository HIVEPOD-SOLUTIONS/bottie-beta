/**
 * Shared harness for the database-backed tests. Runs REAL src/lib code (TypeScript, transpiled on the fly) on an in-memory
 * Postgres (PGlite) built from the real migrations, so nothing touches Neon. Imports of "@/lib/..." resolve to the real source
 * files automatically; only the things that must be faked (the db handle, DNS, env, the network) are stubbed per test.
 *
 *     npm i --no-save @electric-sql/pglite        (once; PGLITE_PATH can point at a folder that already has it)
 */
// Neon runs in UTC, and the code compares database timestamps with JavaScript ones. Newer PGlite takes its session time zone from
// the host PC, which on a machine that is not on UTC shifts every "now()" and fails time-window checks that are correct in production.
process.env.TZ = "UTC";

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
const req = (name) => require(path.join(ROOT, "node_modules", name));

function loadPglite() {
  const tries = [() => require("@electric-sql/pglite"), () => req("@electric-sql/pglite")];
  if (process.env.PGLITE_PATH) tries.push(() => require(path.join(process.env.PGLITE_PATH, "node_modules/@electric-sql/pglite")));
  for (const t of tries) {
    try {
      return t();
    } catch {
      /* try the next place */
    }
  }
  console.error("Missing @electric-sql/pglite. Run: npm i --no-save @electric-sql/pglite");
  process.exit(2);
}

const { PGlite } = loadPglite();
const ts = req("typescript");
const { drizzle: drizzleProxy } = req("drizzle-orm/pg-proxy");
const migrations = require("./_migrations.cjs");

const drizzle = (client, opts) =>
  drizzleProxy(async (query, params, method) => ({ rows: (await client.query(query, params, method === "all" ? { rowMode: "array" } : undefined)).rows }), opts);

const PAYMENTS_TABLE = `create table payments (id uuid primary key default gen_random_uuid(), user_id text not null, type text not null, reference_id text, description text not null, amount_usdc text not null, status text not null, tx_hash text, chain text, created_at timestamp default now() not null)`;

function compile(file) {
  return ts.transpileModule(fs.readFileSync(path.join(ROOT, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
}

/** A loader that resolves "@/..." to the real source, with `stubs` taking priority. Each loader has its own module cache. */
function makeLoader(stubs) {
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    new Function("module", "exports", "require", compile(file))(mod, mod.exports, (name) => {
      if (name in stubs) return stubs[name];
      if (name.startsWith("@/")) {
        const base = `src/${name.slice(2)}`;
        for (const cand of [`${base}.ts`, `${base}/index.ts`]) if (fs.existsSync(path.join(ROOT, cand))) return load(cand);
        throw new Error(`cannot resolve ${name}`);
      }
      if (name === "drizzle-orm" || name === "drizzle-orm/pg-core") return req(name);
      if (["@solana/web3.js", "@solana/spl-token", "bs58", "buffer"].includes(name)) return req(name);
      if ((name === "node:crypto" || name === "node:https") && !(name in stubs)) return require(name);
      throw new Error(`unstubbed import "${name}" in ${file}`);
    });
    return mod.exports;
  };
  return load;
}

/** A fresh in-memory database with every migration applied. */
async function freshDb() {
  const client = new PGlite();
  await client.exec(PAYMENTS_TABLE);
  for (const stmt of migrations.statements) await client.exec(stmt);
  const schema = makeLoader({})("src/lib/db/schema.ts");
  return { client, db: drizzle(client, { schema }) };
}

function reporter() {
  let pass = 0;
  let fail = 0;
  return {
    check(name, ok, detail = "") {
      ok ? pass++ : fail++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  -> ${detail}` : ""}`);
    },
    finish() {
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    },
  };
}

module.exports = { ROOT, req, PGlite, makeLoader, freshDb, reporter, migrations };
