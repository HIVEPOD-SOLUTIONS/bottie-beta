import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Lazy initialization — avoids a module-level throw when DATABASE_URL is
// undefined at import time (e.g. during Next.js cold-start before env vars
// are injected, or in environments where the variable hasn't been set yet).
// The first actual DB call will throw, which the route-level try/catch handles.
let _db: NeonHttpDatabase<typeof schema> | undefined;

function getDb(): NeonHttpDatabase<typeof schema> {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL environment variable is not set");
    _db = drizzle({ client: neon(url), schema });
  }
  return _db;
}

// Transparent proxy so all existing `db.select()`, `db.insert()` etc. work
// unchanged — they just lazily initialise the real client on first use.
export const db = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, prop: string | symbol) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
