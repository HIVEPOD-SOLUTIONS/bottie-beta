import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { getServerEnv } from "@/lib/server-env";

const PRIVY_API = "https://auth.privy.io/api/v1";

function privyHeaders() {
  const appId = getServerEnv("NEXT_PUBLIC_PRIVY_APP_ID");
  const appSecret = getServerEnv("PRIVY_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Privy credentials not configured");

  const creds = Buffer.from(
    `${appId}:${appSecret}`
  ).toString("base64");
  return {
    "Content-Type": "application/json",
    Authorization: `Basic ${creds}`,
    "privy-app-id": appId,
  };
}

// ── Per-user async mutex ──────────────────────────────────────────────────────
// Serializes concurrent writes for the same userId within this server instance.
// Each entry is a promise representing the tail of the write queue for that user.
// When a new write arrives it chains onto the tail, ensuring strict ordering.
const writeQueues = new Map<string, Promise<void>>();

async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const tail = writeQueues.get(userId) ?? Promise.resolve();

  let releaseLock!: () => void;
  const acquired = new Promise<void>((resolve) => { releaseLock = resolve; });

  // Chain this task onto the queue tail
  writeQueues.set(userId, tail.then(() => acquired));

  try {
    await tail;        // wait for all prior writes to finish
    return await fn(); // run our write exclusively
  } finally {
    releaseLock();     // unblock the next write in the queue
    // Clean up the map entry once the queue drains to avoid unbounded growth
    if (writeQueues.get(userId) === acquired) writeQueues.delete(userId);
  }
}

// ── Privy helpers ─────────────────────────────────────────────────────────────

interface VaultPrefs {
  velvet_vaults: string[];
  velvet_hidden: string[];
}

async function fetchUser(userId: string) {
  const res = await fetch(`${PRIVY_API}/users/${encodeURIComponent(userId)}`, {
    headers: privyHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Privy GET ${res.status}`);
  return res.json() as Promise<{ custom_metadata?: Record<string, unknown> }>;
}

function extractPrefs(meta: Record<string, unknown> | undefined): VaultPrefs {
  return {
    velvet_vaults: Array.isArray(meta?.velvet_vaults) ? (meta!.velvet_vaults as string[]) : [],
    velvet_hidden: Array.isArray(meta?.velvet_hidden) ? (meta!.velvet_hidden as string[]) : [],
  };
}

async function writePrefs(
  userId: string,
  existingMeta: Record<string, unknown>,
  prefs: VaultPrefs,
) {
  const res = await fetch(
    `${PRIVY_API}/users/${encodeURIComponent(userId)}/custom_metadata`,
    {
      method: "PUT",
      headers: privyHeaders(),
      body: JSON.stringify({
        custom_metadata: {
          ...existingMeta,
          velvet_vaults: [...new Set(prefs.velvet_vaults)],
          velvet_hidden: [...new Set(prefs.velvet_hidden)],
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Privy PUT ${res.status}: ${await res.text()}`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/velvet/vaults
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  try {
    const user = await fetchUser(userId);
    return Response.json(extractPrefs(user.custom_metadata));
  } catch (err: unknown) {
    console.error("[velvet/vaults GET]", err);
    // Return empty prefs rather than a 500 so the page still renders
    return Response.json({ velvet_vaults: [], velvet_hidden: [] });
  }
}

// POST /api/velvet/vaults
// Body: { action: "add_vault"|"remove_vault"|"hide_vault"|"unhide_vault", address: string }
export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  let action: string, address: string;
  try {
    ({ action, address } = await req.json());
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!action || !address) return new Response("action and address required", { status: 400 });
  if (!["add_vault", "remove_vault", "hide_vault", "unhide_vault"].includes(action)) {
    return new Response("Unknown action", { status: 400 });
  }

  const addr = address.toLowerCase();

  try {
    // All writes for this user are serialized through the per-user queue.
    // Each write reads the latest state from Privy, applies its change, then
    // writes back — so concurrent requests see each other's changes rather
    // than racing on a stale snapshot.
    const prefs = await withUserLock(userId, async () => {
      const user = await fetchUser(userId);
      const existingMeta = user.custom_metadata ?? {};
      const prefs = extractPrefs(existingMeta);

      if (action === "add_vault") {
        prefs.velvet_vaults = [...new Set([...prefs.velvet_vaults, addr])];
        prefs.velvet_hidden = prefs.velvet_hidden.filter((a) => a !== addr);
      } else if (action === "remove_vault") {
        prefs.velvet_vaults = prefs.velvet_vaults.filter((a) => a !== addr);
      } else if (action === "hide_vault") {
        prefs.velvet_hidden = [...new Set([...prefs.velvet_hidden, addr])];
        prefs.velvet_vaults = prefs.velvet_vaults.filter((a) => a !== addr);
      } else if (action === "unhide_vault") {
        prefs.velvet_hidden = prefs.velvet_hidden.filter((a) => a !== addr);
      }

      await writePrefs(userId, existingMeta, prefs);
      return prefs;
    });

    return Response.json(prefs);
  } catch (err: unknown) {
    console.error("[velvet/vaults POST]", err);
    return new Response((err as Error)?.message ?? "Failed to save prefs", { status: 502 });
  }
}
