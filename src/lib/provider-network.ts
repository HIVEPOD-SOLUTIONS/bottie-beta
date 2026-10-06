import { promises as dns } from "node:dns";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerListings, providerUsage } from "@/lib/db/schema";
import { getServerEnv } from "@/lib/server-env";
import { NETWORK, isPublicIp, safePublicUrl, slugify, validateListingInput } from "@/lib/provider-network-rules";
import { SHAR, handleFor } from "@/lib/shar-rules";

/**
 * The open provider network: anyone adds a provider or protocol (or remixes one), the team verifies it, and once people use it
 * the owner earns Shar. Paid calls and x402 commission are the next stage: listings can state a price, but the gateway only
 * runs free providers until x402 settlement is switched on.
 */

type Listing = typeof providerListings.$inferSelect;
const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;

export function isNetworkAdmin(userId: string): boolean {
  const ids = (getServerEnv("NETWORK_ADMIN_USER_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(userId);
}

const startOfUtcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

// ── Listings ──────────────────────────────────────────────────────────────────

export async function createListing(userId: string, body: unknown) {
  const checked = validateListingInput(body);
  if (!checked.ok) return { ok: false as const, status: 400, error: checked.error };
  const v = checked.value;

  const [{ owned }] = await db.select({ owned: count() }).from(providerListings).where(eq(providerListings.ownerUserId, userId));
  if (owned >= NETWORK.maxListingsPerUser) {
    return { ok: false as const, status: 409, error: `You can have up to ${NETWORK.maxListingsPerUser} listings. Pause or remove one first.` };
  }
  const [{ today }] = await db
    .select({ today: count() })
    .from(providerListings)
    .where(and(eq(providerListings.ownerUserId, userId), gte(providerListings.createdAt, startOfUtcDay())));
  if (today >= NETWORK.maxSubmissionsPerDay) {
    return { ok: false as const, status: 429, error: "That's enough submissions for today. Try again tomorrow." };
  }

  if (v.remixOfId) {
    const [source] = await db.select({ id: providerListings.id }).from(providerListings)
      .where(and(eq(providerListings.id, v.remixOfId), eq(providerListings.status, "verified"))).limit(1);
    if (!source) return { ok: false as const, status: 404, error: "That provider to remix wasn't found." };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [row] = await db.insert(providerListings).values({
        ownerUserId: userId,
        name: v.name,
        slug: slugify(v.name),
        summary: v.summary,
        category: v.category,
        endpointUrl: v.endpointUrl,
        docsUrl: v.docsUrl,
        priceUsdc: v.priceUsdc,
        payoutWallet: v.payoutWallet,
        remixOfId: v.remixOfId,
      }).returning();
      return { ok: true as const, listing: row };
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code !== "23505") throw err; // only a slug clash is worth another try
    }
  }
  return { ok: false as const, status: 500, error: "Couldn't save the listing. Try again." };
}

const PUBLIC_SQL_COUNTS = sql`
  select l.id,
    (select count(*) from provider_usage u where u.listing_id = l.id) as uses,
    (select count(*) from provider_listings r where r.remix_of_id = l.id and r.status = 'verified') as remixes
  from provider_listings l`;

async function countsFor(ids: string[]) {
  if (ids.length === 0) return new Map<string, { uses: number; remixes: number }>();
  const rows = rowsOf<{ id: string; uses: string; remixes: string }>(
    await db.execute(sql`select * from (${PUBLIC_SQL_COUNTS}) c where c.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`),
  );
  return new Map(rows.map((r) => [r.id, { uses: num(r.uses), remixes: num(r.remixes) }]));
}

/** What anyone signed in can see of a verified listing: no endpoint URL (calls go through the gateway), only its host. */
export async function listVerified(viewerId: string) {
  const rows = await db.select().from(providerListings).where(eq(providerListings.status, "verified")).orderBy(desc(providerListings.verifiedAt)).limit(100);
  const counts = await countsFor(rows.map((r) => r.id));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      summary: r.summary,
      category: r.category,
      docsUrl: r.docsUrl,
      priceUsdc: r.priceUsdc,
      host: safePublicUrl(r.endpointUrl)?.hostname ?? null,
      remixOf: r.remixOfId && names.has(r.remixOfId) ? { id: r.remixOfId, name: names.get(r.remixOfId)! } : null,
      uses: counts.get(r.id)?.uses ?? 0,
      remixes: counts.get(r.id)?.remixes ?? 0,
      owner: await handleFor(r.ownerUserId),
      mine: r.ownerUserId === viewerId,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

/** The person's own listings in every state, with what each has earned. */
export async function listMine(userId: string) {
  const rows = await db.select().from(providerListings).where(eq(providerListings.ownerUserId, userId)).orderBy(desc(providerListings.createdAt));
  const counts = await countsFor(rows.map((r) => r.id));
  const earned = rows.length
    ? rowsOf<{ listing_id: string; shar: string }>(
        await db.execute(sql`select listing_id, coalesce(sum(shar), 0) as shar from provider_usage where listing_id in (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)}) group by listing_id`),
      )
    : [];
  const earnedBy = new Map(earned.map((e) => [e.listing_id, num(e.shar)]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    summary: r.summary,
    category: r.category,
    endpointUrl: r.endpointUrl,
    docsUrl: r.docsUrl,
    priceUsdc: r.priceUsdc,
    payoutWallet: r.payoutWallet,
    remixOfId: r.remixOfId,
    status: r.status,
    reviewNote: r.reviewNote,
    uses: counts.get(r.id)?.uses ?? 0,
    shar: earnedBy.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function reviewListing(id: string, action: unknown, note: unknown) {
  const next = action === "verify" ? "verified" : action === "reject" ? "rejected" : action === "pause" ? "paused" : null;
  if (!next) return { ok: false as const, status: 400, error: "action must be verify, reject or pause" };
  const reviewNote = typeof note === "string" ? note.trim().slice(0, 500) || null : null;
  const [row] = await db.update(providerListings)
    .set({ status: next, reviewNote, verifiedAt: next === "verified" ? new Date() : null })
    .where(eq(providerListings.id, id)).returning();
  if (!row) return { ok: false as const, status: 404, error: "Listing not found" };
  return { ok: true as const, listing: { id: row.id, status: row.status } };
}

export async function getListing(id: string): Promise<Listing | null> {
  const [row] = await db.select().from(providerListings).where(eq(providerListings.id, id)).limit(1);
  return row ?? null;
}

// ── Usage and the gateway ─────────────────────────────────────────────────────

/**
 * Records one use and decides what it earns the owner. Nothing is earned when the owner uses their own provider, after the same
 * person has already earned the owner five uses today, or once the owner has hit their daily Shar cap: SKR is at stake, so
 * Shar can't be farmed by calling a provider in a loop. (Counted just before the insert, so a burst of parallel calls can
 * overshoot a cap slightly.)
 */
export async function recordUsage(listing: Pick<Listing, "id" | "ownerUserId">, callerUserId: string, amountUsdc = "0", settlementRef: string | null = null) {
  let shar: number = SHAR.providerUseShar;
  const dayStart = startOfUtcDay();
  if (callerUserId === listing.ownerUserId) {
    shar = 0;
  } else {
    const [{ byCaller }] = await db
      .select({ byCaller: count() })
      .from(providerUsage)
      .where(and(eq(providerUsage.listingId, listing.id), eq(providerUsage.callerUserId, callerUserId), gte(providerUsage.createdAt, dayStart), sql`${providerUsage.shar} > 0`));
    if (byCaller >= NETWORK.earningUsesPerCallerPerDay) shar = 0;
    if (shar > 0) {
      const mine = await db.select({ id: providerListings.id }).from(providerListings).where(eq(providerListings.ownerUserId, listing.ownerUserId));
      const [{ ownerToday }] = await db
        .select({ ownerToday: sql<number>`coalesce(sum(${providerUsage.shar}), 0)::int` })
        .from(providerUsage)
        .where(and(inArray(providerUsage.listingId, mine.map((m) => m.id)), gte(providerUsage.createdAt, dayStart)));
      if (Number(ownerToday) + shar > NETWORK.ownerDailyShar) shar = 0;
    }
  }
  await db.insert(providerUsage).values({ listingId: listing.id, callerUserId, amountUsdc, shar, settlementRef });
  return { shar };
}

/** Every address the host resolves to must be public. Checked on every call, not just when the listing was submitted. */
export async function assertResolvesPublic(host: string): Promise<boolean> {
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => isPublicIp(a.address));
  } catch {
    return false;
  }
}

export type GatewayResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

/** Calls a verified, free provider with the caller's JSON. No redirects, a short timeout and a capped response. */
export async function callProvider(listing: Listing, payload: unknown): Promise<GatewayResult> {
  const url = safePublicUrl(listing.endpointUrl);
  if (!url || !(await assertResolvesPublic(url.hostname))) return { ok: false, status: 502, error: "This provider can't be reached right now." };
  const bodyText = JSON.stringify(payload ?? {});
  if (bodyText.length > NETWORK.maxRequestBytes) return { ok: false, status: 413, error: "Request too large." };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Bluvfi-Provider-Gateway/1.0", "X-Bluvfi-Listing": listing.id },
      body: bodyText,
      redirect: "manual",
      signal: AbortSignal.timeout(NETWORK.callTimeoutMs),
      cache: "no-store",
    });
    if (res.status >= 300 && res.status < 400) return { ok: false, status: 502, error: "The provider tried to redirect, which isn't allowed." };
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > NETWORK.maxResponseBytes) {
        await reader.cancel();
        return { ok: false, status: 502, error: "The provider's response was too large." };
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain text is fine */
    }
    return { ok: true, status: res.status, body };
  } catch {
    return { ok: false, status: 502, error: "The provider didn't answer in time." };
  }
}
