import { promises as dns } from "node:dns";
import { and, count, desc, eq, gte, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerConfigs, providerCreators, providerListings, providerPublishers, providerTerms, providerTermsAcceptances, providerUsage } from "@/lib/db/schema";
import { getServerEnv } from "@/lib/server-env";
import { NETWORK, NOTHING_TO_CHANGE, editPlan, isPublicIp, ownerActionPlan, safePublicUrl, slugify, validateListingInput, validateListingUpdate, type Browse, type ListingChanges } from "@/lib/provider-network-rules";
import { PROVIDER_TERMS_VERSION, validateCreatorSignup, validateCreatorUpdate, validateRightsConfirmed, type CreatorInput, type OperatorType, type PublisherInput } from "@/lib/provider-publisher-rules";
import {
  authHeaderFor,
  normalizeInputFields,
  normalizeRequirements,
  normalizeSetupUrl,
  normalizeTeamNotes,
  validateAuth,
  validateCallInput,
  validateConfigInput,
  type AuthType,
  type ConfigInput,
  type InputField,
} from "@/lib/provider-config-rules";
import { decryptSecret, encryptSecret, secretsEnabled } from "@/lib/secret-box";
import { normalizeCustomTerms, termsHash, type CustomTerms } from "@/lib/provider-terms-rules";
import { SHAR, handleFor } from "@/lib/shar-rules";
import { debitForCall, getBalanceMicro, refundCall } from "@/lib/credits";
import { pinnedPost } from "@/lib/pinned-request";
import { sharesDevice } from "@/lib/abuse";
import { isValidPriceMicro, microToDecimal, splitPrice, usdToMicro } from "@/lib/payments-rules";

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

type ConfigRow = typeof providerConfigs.$inferSelect;

const configHasContent = (c: ConfigInput) => !!(c.inputFields || c.requirements || c.setupUrl || c.teamNotes || c.auth.type !== "none");

/** The row stored for a listing's configuration. The credential is encrypted here and never kept in the clear. */
function configRowFor(listingId: string, c: ConfigInput): typeof providerConfigs.$inferInsert {
  return {
    listingId,
    inputFields: c.inputFields ? JSON.stringify(c.inputFields) : null,
    requirements: c.requirements ? JSON.stringify(c.requirements) : null,
    setupUrl: c.setupUrl,
    teamNotes: c.teamNotes,
    authType: c.auth.type,
    authHeader: c.auth.header,
    authSecretEnc: c.auth.secret ? encryptSecret(c.auth.secret, listingId) : null,
  };
}

/**
 * Adds a listing. When `publisher` is given (every submission from the app has one, see submitListing) it is stored alongside, and
 * so is the `config`. If either can't be stored the listing is removed again, so a listing never exists without the terms
 * acceptance (or the setup) it was submitted with.
 */
export async function createListing(userId: string, body: unknown, publisher?: PublisherInput, config?: ConfigInput, customTerms?: CustomTerms | null) {
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
      const id = crypto.randomUUID();
      const [row] = await db.insert(providerListings).values({
        id,
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
        exampleRequest: v.exampleRequest,
      }).returning();
      try {
        if (publisher) {
          await db.insert(providerPublishers).values({
            listingId: id,
            ownerUserId: userId,
            operatorType: publisher.operatorType,
            companyName: publisher.companyName,
            companyWebsite: publisher.companyWebsite,
            contactEmail: publisher.contactEmail,
            rightsConfirmed: true,
            termsVersion: publisher.termsVersion,
          });
        }
        if (config && configHasContent(config)) await db.insert(providerConfigs).values(configRowFor(id, config));
        if (customTerms) await db.insert(providerTerms).values({ listingId: id, termsText: customTerms.text, termsUrl: customTerms.url, termsHash: termsHash(customTerms) });
      } catch (sideErr) {
        await db.delete(providerTerms).where(eq(providerTerms.listingId, id)).catch(() => {});
        await db.delete(providerConfigs).where(eq(providerConfigs.listingId, id)).catch(() => {});
        await db.delete(providerPublishers).where(eq(providerPublishers.listingId, id)).catch(() => {});
        await db.delete(providerListings).where(eq(providerListings.id, id)).catch(() => {});
        throw sideErr;
      }
      return { ok: true as const, listing: row };
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code !== "23505") throw err; // only a slug clash is worth another try
    }
  }
  return { ok: false as const, status: 500, error: "Couldn't save the listing. Try again." };
}

/** Why a submission was refused, when the app should react to the reason (not just show the message). */
export type SubmitCode = "creator_required" | "creator_terms_outdated";

/**
 * A new provider from the app. Only CREATORS can add one: becoming a creator is an opt-in sign-up (see enrollCreator), not something
 * every account can do. The creator's profile (who they are, contact email, the provider terms they agreed to) is recorded with the
 * listing; the listing itself needs its own confirmation that they own the service or may offer it, plus its setup (inputs,
 * requirements, credentials, notes for the team), which is optional.
 */
export async function submitListing(userId: string, body: unknown): Promise<Awaited<ReturnType<typeof createListing>> | { ok: false; status: number; error: string; code?: SubmitCode }> {
  const rights = validateRightsConfirmed(body);
  if (!rights.ok) return { ok: false as const, status: 400, error: rights.error };
  const creator = await getCreator(userId);
  if (!creator) return { ok: false as const, status: 403, code: "creator_required" as const, error: "Become a provider creator first. It takes a minute and is free." };
  if (creator.termsVersion !== PROVIDER_TERMS_VERSION) {
    return { ok: false as const, status: 409, code: "creator_terms_outdated" as const, error: "Bluvfi's provider terms have changed. Read and agree to them again before adding a provider." };
  }
  const publisher = { ok: true as const, value: { operatorType: creator.operatorType, companyName: creator.companyName, companyWebsite: creator.companyWebsite, contactEmail: creator.contactEmail, termsVersion: creator.termsVersion } satisfies PublisherInput };
  const copied = await resolveCopiedSecret(userId, (body as Record<string, unknown>).auth);
  if (!copied.ok) return { ok: false as const, status: copied.status, error: copied.error };
  const config = validateConfigInput({ ...(body as Record<string, unknown>), auth: copied.auth });
  if (!config.ok) return { ok: false as const, status: 400, error: config.error };
  const terms = normalizeCustomTerms((body as Record<string, unknown>).customTerms);
  if (!terms.ok) return { ok: false as const, status: 400, error: terms.error };
  if (config.value.auth.secret && !secretsEnabled()) {
    return { ok: false as const, status: 503, error: "Saving an API key isn’t switched on yet. List it without a key, or try again soon." };
  }
  return createListing(userId, body, publisher.value, config.value, terms.value);
}

// ── Creators: an opt-in sign-up ───────────────────────────────────────────────

export interface Creator {
  operatorType: OperatorType;
  companyName: string | null;
  companyWebsite: string | null;
  contactEmail: string;
  termsVersion: string;
  termsAcceptedAt: string | null;
}

/** The person's creator profile, or null if they haven't signed up. Throws if the table doesn't exist yet (callers answer "being set up"). */
export async function getCreator(userId: string): Promise<Creator | null> {
  const [r] = await db.select().from(providerCreators).where(eq(providerCreators.userId, userId)).limit(1);
  if (!r) return null;
  return {
    operatorType: r.operatorType as OperatorType,
    companyName: r.companyName,
    companyWebsite: r.companyWebsite,
    contactEmail: r.contactEmail,
    termsVersion: r.termsVersion,
    termsAcceptedAt: r.termsAcceptedAt ? new Date(r.termsAcceptedAt).toISOString() : null,
  };
}

/**
 * Signing up to be a creator (or agreeing again after the provider terms changed). Idempotent: signing up twice just refreshes the
 * details and the agreement. Returns the profile.
 */
export async function enrollCreator(userId: string, body: unknown) {
  const input = validateCreatorSignup(body);
  if (!input.ok) return { ok: false as const, status: 400, error: input.error };
  const v: CreatorInput = input.value;
  await db
    .insert(providerCreators)
    .values({ userId, operatorType: v.operatorType, companyName: v.companyName, companyWebsite: v.companyWebsite, contactEmail: v.contactEmail, termsVersion: v.termsVersion })
    .onConflictDoUpdate({
      target: providerCreators.userId,
      set: { operatorType: v.operatorType, companyName: v.companyName, companyWebsite: v.companyWebsite, contactEmail: v.contactEmail, termsVersion: v.termsVersion, termsAcceptedAt: sql`now()`, updatedAt: sql`now()` },
    });
  await syncPublishers(userId, v);
  return { ok: true as const, creator: (await getCreator(userId))! };
}

/** A creator changing who they are or how to reach them. Free (no review). Their existing listings' records are kept in step. */
export async function updateCreator(userId: string, body: unknown) {
  const current = await getCreator(userId);
  if (!current) return { ok: false as const, status: 403, code: "creator_required" as const, error: "You haven't signed up as a creator yet." };
  const r = validateCreatorUpdate(body, { operatorType: current.operatorType, companyName: current.companyName, companyWebsite: current.companyWebsite, contactEmail: current.contactEmail });
  if (!r.ok) return { ok: false as const, status: 400, error: r.error };
  if (r.kind === "none") return { ok: false as const, status: 400, error: "Nothing to change." };
  await db
    .update(providerCreators)
    .set({ operatorType: r.value.operatorType, companyName: r.value.companyName, companyWebsite: r.value.companyWebsite, contactEmail: r.value.contactEmail, updatedAt: sql`now()` })
    .where(eq(providerCreators.userId, userId));
  await syncPublishers(userId, r.value);
  return { ok: true as const, creator: (await getCreator(userId))! };
}

/** Keeps each listing's record of "who is behind it" in step with the creator's profile (the team reads those). Missing table: nothing to keep. */
async function syncPublishers(userId: string, v: { operatorType: OperatorType; companyName: string | null; companyWebsite: string | null; contactEmail: string }) {
  try {
    await db
      .update(providerPublishers)
      .set({ operatorType: v.operatorType, companyName: v.companyName, companyWebsite: v.companyWebsite, contactEmail: v.contactEmail })
      .where(eq(providerPublishers.ownerUserId, userId));
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
}

// ── Setup: inputs, requirements, credentials, team notes ──────────────────────

const parseJson = <T>(text: string | null | undefined): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** Setup rows for some listings. Empty when the table isn't there yet: a provider without setup is just a free-form one. */
export async function getConfigs(listingIds: string[]): Promise<Map<string, ConfigRow>> {
  if (listingIds.length === 0) return new Map();
  try {
    const rows = await db.select().from(providerConfigs).where(inArray(providerConfigs.listingId, listingIds));
    return new Map(rows.map((r) => [r.listingId, r]));
  } catch {
    return new Map();
  }
}

// ── The owner's own terms, and who agreed to them ─────────────────────────────

export interface OwnerTerms {
  text: string | null;
  url: string | null;
  /** The fingerprint of this version: an agreement is to this exact version. */
  hash: string;
}

/** The owners' terms for some listings. Empty when the table isn't there yet: a provider without terms is just a provider. */
export async function getTerms(listingIds: string[]): Promise<Map<string, OwnerTerms>> {
  if (listingIds.length === 0) return new Map();
  try {
    const rows = await db.select().from(providerTerms).where(inArray(providerTerms.listingId, listingIds));
    return new Map(rows.map((r) => [r.listingId, { text: r.termsText, url: r.termsUrl, hash: r.termsHash }]));
  } catch {
    return new Map();
  }
}

/** When this person agreed to the CURRENT version of a listing's terms, or null. */
export async function termsAcceptedAt(listingId: string, userId: string, hash: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ at: providerTermsAcceptances.acceptedAt })
      .from(providerTermsAcceptances)
      .where(and(eq(providerTermsAcceptances.listingId, listingId), eq(providerTermsAcceptances.userId, userId), eq(providerTermsAcceptances.termsHash, hash)))
      .limit(1);
    return row ? new Date(row.at).toISOString() : null;
  } catch {
    return null;
  }
}

/** Records that someone agreed to a version of a provider's terms. Only the CURRENT version can be agreed to, and only for a live provider. */
export async function acceptTerms(userId: string, listingId: string, hash: unknown) {
  const l = await getListing(listingId);
  if (!l || l.status !== "verified") return { ok: false as const, status: 404, error: "Provider not found." };
  const current = (await getTerms([listingId])).get(listingId);
  if (!current) return { ok: false as const, status: 409, error: "This provider has no terms to agree to." };
  if (hash !== current.hash) return { ok: false as const, status: 409, error: "The terms changed. Reload the provider and read them again." };
  await db.insert(providerTermsAcceptances).values({ listingId, userId, termsHash: current.hash }).onConflictDoNothing();
  return { ok: true as const, acceptedAt: (await termsAcceptedAt(listingId, userId, current.hash)) ?? new Date().toISOString() };
}

/**
 * Whether this person may call the provider as far as the owner's terms go: no terms, their own provider, or they agreed to the current
 * version. A database problem other than the table being absent REFUSES the call (an agreement we can't check is not an agreement).
 */
async function termsGate(listing: Pick<Listing, "id" | "ownerUserId">, userId: string): Promise<{ ok: true } | { ok: false; status: number; error: string; code: "terms_required" }> {
  if (userId === listing.ownerUserId) return { ok: true };
  let current: OwnerTerms | undefined;
  try {
    const [row] = await db.select().from(providerTerms).where(eq(providerTerms.listingId, listing.id)).limit(1);
    if (row) current = { text: row.termsText, url: row.termsUrl, hash: row.termsHash };
  } catch (err) {
    if (missingTable(err)) return { ok: true };
    return { ok: false, status: 503, code: "terms_required", error: "Couldn't check this provider's terms right now. Try again in a moment." };
  }
  if (!current) return { ok: true };
  if (await termsAcceptedAt(listing.id, userId, current.hash)) return { ok: true };
  return { ok: false, status: 409, code: "terms_required", error: "Read and agree to this provider's terms first. You weren't charged." };
}

/** What anyone who can open the provider sees of its setup. */
export const publicConfig = (row?: ConfigRow) => ({
  inputFields: parseJson<InputField[]>(row?.inputFields),
  requirements: parseJson<string[]>(row?.requirements),
  setupUrl: row?.setupUrl ?? null,
});

/** What the owner and the team see: the public setup plus the private notes and whether a key is saved. The key itself never leaves the server. */
export const describeConfig = (row?: ConfigRow) => ({
  ...publicConfig(row),
  teamNotes: row?.teamNotes ?? null,
  auth: { type: (row?.authType ?? "none") as AuthType, header: row?.authHeader ?? null, hasSecret: !!row?.authSecretEnc },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Use the same key as my other provider". The key never leaves the server: it is decrypted here from a provider the person OWNS and
 * saved on this one like a key they had typed (re-encrypted for the new listing). A key typed in the same request wins. Only the
 * owner's own providers can be copied from; anything else is "not found", so ids of other people's providers can't be probed.
 */
async function resolveCopiedSecret(userId: string, auth: unknown): Promise<{ ok: true; auth: unknown } | { ok: false; status: number; error: string }> {
  if (typeof auth !== "object" || auth === null) return { ok: true, auth };
  const a = auth as Record<string, unknown>;
  const from = a.copySecretFrom;
  if (from === undefined || from === null || from === "") return { ok: true, auth };
  if (typeof a.secret === "string" && a.secret.trim()) return { ok: true, auth };
  const notFound = { ok: false as const, status: 404, error: "The provider to copy the key from wasn’t found." };
  if (typeof from !== "string" || !UUID_RE.test(from)) return { ok: false, status: 400, error: "The provider to copy the key from wasn’t found." };
  const source = await getListing(from);
  if (!source || source.ownerUserId !== userId || source.status === "removed") return notFound;
  const row = (await getConfigs([from])).get(from);
  const secret = row?.authSecretEnc ? decryptSecret(row.authSecretEnc, from) : null;
  if (!secret) return { ok: false, status: 409, error: "That provider has no key saved, or it can’t be read. Enter the key instead." };
  return { ok: true, auth: { ...a, secret } };
}

/** A caller's request checked against the provider's inputs: refused here, before anything is charged or sent. */
export async function checkCallInput(listingId: string, payload: unknown) {
  const fields = publicConfig((await getConfigs([listingId])).get(listingId)).inputFields;
  return validateCallInput(fields, payload);
}

const missingTable = (err: unknown) => {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  return (e?.code ?? e?.cause?.code) === "42P01" || /relation .* does not exist/i.test(`${e?.message} ${e?.cause?.message}`);
};

/**
 * The header Bluvfi sends to the provider's endpoint, from the encrypted key saved for it. Fails CLOSED: if a key is set up but can't
 * be read (key lost, value tampered with), the call is refused rather than sent without it.
 */
export async function loadProviderAuth(listingId: string): Promise<{ ok: true; header: { name: string; value: string } | null } | { ok: false }> {
  let row: ConfigRow | undefined;
  try {
    [row] = await db.select().from(providerConfigs).where(eq(providerConfigs.listingId, listingId)).limit(1);
  } catch (err) {
    return missingTable(err) ? { ok: true, header: null } : { ok: false };
  }
  if (!row || row.authType === "none") return { ok: true, header: null };
  const secret = row.authSecretEnc ? decryptSecret(row.authSecretEnc, listingId) : null;
  const header = secret ? authHeaderFor(row.authType as AuthType, row.authHeader, secret) : null;
  return header ? { ok: true, header } : { ok: false };
}

export interface PublisherInfo {
  operatorType: string;
  companyName: string | null;
  companyWebsite: string | null;
  contactEmail: string;
  rightsConfirmed: boolean;
  termsVersion: string;
  termsAcceptedAt: string | null;
}

/** Publisher details for some listings, for the team. Empty when the table isn't there yet or a listing predates the questions. */
export async function getPublishers(listingIds: string[]): Promise<Map<string, PublisherInfo>> {
  if (listingIds.length === 0) return new Map();
  try {
    const rows = await db.select().from(providerPublishers).where(inArray(providerPublishers.listingId, listingIds));
    return new Map(
      rows.map((r) => [
        r.listingId,
        {
          operatorType: r.operatorType,
          companyName: r.companyName,
          companyWebsite: r.companyWebsite,
          contactEmail: r.contactEmail,
          rightsConfirmed: r.rightsConfirmed,
          termsVersion: r.termsVersion,
          termsAcceptedAt: r.termsAcceptedAt ? new Date(r.termsAcceptedAt).toISOString() : null,
        },
      ]),
    );
  } catch {
    return new Map();
  }
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

const likePattern = (q: string) => "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

/**
 * What anyone signed in can see of a verified listing: no endpoint URL (calls go through the gateway), only its host.
 * Searchable by name, description and category; filterable by category and "free"; sorted featured-first (default), by most used,
 * or newest.
 */
export async function listVerified(viewerId: string, browse: Browse = { q: "", category: null, sort: "featured", free: false }) {
  const where = [eq(providerListings.status, "verified")];
  if (browse.category) where.push(eq(providerListings.category, browse.category));
  if (browse.free) where.push(eq(providerListings.priceUsdc, "0"));
  if (browse.q) {
    const like = likePattern(browse.q);
    where.push(or(ilike(providerListings.name, like), ilike(providerListings.summary, like), ilike(providerListings.category, like))!);
  }
  const rows = await db.select().from(providerListings).where(and(...where))
    .orderBy(desc(providerListings.featured), desc(providerListings.verifiedAt)).limit(200);
  const counts = await countsFor(rows.map((r) => r.id));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const uses = (id: string) => counts.get(id)?.uses ?? 0;
  const ordered =
    browse.sort === "popular" ? [...rows].sort((a, b) => uses(b.id) - uses(a.id) || Number(b.featured) - Number(a.featured))
    : browse.sort === "new" ? [...rows].sort((a, b) => (b.verifiedAt?.getTime() ?? 0) - (a.verifiedAt?.getTime() ?? 0))
    : rows;
  const page = ordered.slice(0, 100);
  const configs = await getConfigs(page.map((r) => r.id));
  const termsById = await getTerms(page.map((r) => r.id));
  return Promise.all(
    page.map(async (r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      summary: r.summary,
      category: r.category,
      docsUrl: r.docsUrl,
      priceUsdc: r.priceUsdc,
      host: safePublicUrl(r.endpointUrl)?.hostname ?? null,
      featured: r.featured,
      exampleRequest: r.exampleRequest,
      ...publicConfig(configs.get(r.id)),
      hasOwnerTerms: termsById.has(r.id),
      remixOf: r.remixOfId && names.has(r.remixOfId) ? { id: r.remixOfId, name: names.get(r.remixOfId)! } : null,
      uses: uses(r.id),
      remixes: counts.get(r.id)?.remixes ?? 0,
      owner: await handleFor(r.ownerUserId),
      mine: r.ownerUserId === viewerId,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}

/**
 * One provider's page. Anyone signed in can open a verified provider; the owner can also open their own in any state except
 * removed, so they can preview it. Never includes the endpoint URL (only its host) or the payout wallet.
 */
export async function getProviderDetail(id: string, viewerId: string) {
  const l = await getListing(id);
  if (!l || l.status === "removed") return null;
  const mine = l.ownerUserId === viewerId;
  if (l.status !== "verified" && !mine) return null;
  const counts = await countsFor([l.id]);
  let remixOf: { id: string; name: string } | null = null;
  if (l.remixOfId) {
    const src = await getListing(l.remixOfId);
    if (src && src.status === "verified") remixOf = { id: src.id, name: src.name };
  }
  return {
    id: l.id,
    name: l.name,
    slug: l.slug,
    summary: l.summary,
    category: l.category,
    docsUrl: l.docsUrl,
    priceUsdc: l.priceUsdc,
    host: safePublicUrl(l.endpointUrl)?.hostname ?? null,
    exampleRequest: l.exampleRequest,
    ...publicConfig((await getConfigs([l.id])).get(l.id)),
    ...(await (async () => {
      const t = (await getTerms([l.id])).get(l.id);
      return { terms: t ?? null, termsAcceptedAt: t ? await termsAcceptedAt(l.id, viewerId, t.hash) : null };
    })()),
    featured: l.featured,
    status: l.status,
    remixOf,
    uses: counts.get(l.id)?.uses ?? 0,
    remixes: counts.get(l.id)?.remixes ?? 0,
    owner: await handleFor(l.ownerUserId),
    mine,
    createdAt: l.createdAt.toISOString(),
    verifiedAt: l.verifiedAt ? l.verifiedAt.toISOString() : null,
  };
}

/** The person's own listings in every state, with what each has earned. */
export async function listMine(userId: string) {
  const rows = await db.select().from(providerListings)
    .where(and(eq(providerListings.ownerUserId, userId), ne(providerListings.status, "removed"))).orderBy(desc(providerListings.createdAt));
  const counts = await countsFor(rows.map((r) => r.id));
  const earned = rows.length
    ? rowsOf<{ listing_id: string; shar: string }>(
        await db.execute(sql`select listing_id, coalesce(sum(shar), 0) as shar from provider_usage where listing_id in (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)}) group by listing_id`),
      )
    : [];
  const earnedBy = new Map(earned.map((e) => [e.listing_id, num(e.shar)]));
  const configs = await getConfigs(rows.map((r) => r.id));
  const publishers = await getPublishers(rows.map((r) => r.id));
  const ownTerms = await getTerms(rows.map((r) => r.id));
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
    exampleRequest: r.exampleRequest,
    ...describeConfig(configs.get(r.id)),
    publisher: publishers.get(r.id) ?? null,
    terms: ownTerms.get(r.id) ?? null,
    featured: r.featured,
    pausedByOwner: r.pausedByOwner,
    uses: counts.get(r.id)?.uses ?? 0,
    shar: earnedBy.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** The team's decision on a listing: verify, reject, pause, or (for a verified one) feature or unfeature. */
export async function reviewListing(id: string, action: unknown, note: unknown) {
  const reviewNote = typeof note === "string" ? note.trim().slice(0, 500) || null : null;
  if (action === "feature" || action === "unfeature") {
    const [row] = await db.update(providerListings)
      .set(action === "feature" ? { featured: true, featuredAt: sql`now()`, updatedAt: sql`now()` } : { featured: false, featuredAt: null, updatedAt: sql`now()` })
      .where(and(eq(providerListings.id, id), eq(providerListings.status, "verified"))).returning();
    if (!row) {
      const exists = await getListing(id);
      if (!exists || exists.status === "removed") return { ok: false as const, status: 404, error: "Listing not found" };
      return { ok: false as const, status: 409, error: "Only a verified provider can be featured." };
    }
    return { ok: true as const, listing: { id: row.id, status: row.status, featured: row.featured } };
  }
  if (action === "request_info") {
    // The team needs something from the owner before deciding: the listing stays in the queue, with the question on it.
    if (!reviewNote) return { ok: false as const, status: 400, error: "Say what you need from the owner." };
    const [row] = await db.update(providerListings)
      .set({ reviewNote, updatedAt: sql`now()` })
      .where(and(eq(providerListings.id, id), eq(providerListings.status, "submitted"))).returning();
    if (!row) {
      const exists = await getListing(id);
      if (!exists || exists.status === "removed") return { ok: false as const, status: 404, error: "Listing not found" };
      return { ok: false as const, status: 409, error: "Only a listing waiting for review can be asked for more information." };
    }
    return { ok: true as const, listing: { id: row.id, status: row.status, featured: row.featured } };
  }
  const next = action === "verify" ? "verified" : action === "reject" ? "rejected" : action === "pause" ? "paused" : null;
  if (!next) return { ok: false as const, status: 400, error: "action must be verify, reject, request_info, pause, feature or unfeature" };
  const [row] = await db.update(providerListings)
    .set({
      status: next,
      reviewNote,
      verifiedAt: next === "verified" ? new Date() : null,
      pausedByOwner: false, // the team's decision, not the owner's: only the team turns it back on
      ...(next !== "verified" ? { featured: false, featuredAt: null } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(providerListings.id, id), ne(providerListings.status, "removed"))).returning();
  if (!row) return { ok: false as const, status: 404, error: "Listing not found" };
  return { ok: true as const, listing: { id: row.id, status: row.status, featured: row.featured } };
}

// ── The owner manages their own listing ───────────────────────────────────────

const CONFIG_KEYS = ["inputFields", "requirements", "setupUrl", "teamNotes", "auth"] as const;

type Planned = { ok: true; changed: boolean; reviewNeeded: boolean; apply: () => Promise<void> } | { ok: false; status: number; error: string };
const NOTHING: Planned = { ok: true, changed: false, reviewNeeded: false, apply: async () => {} };

/**
 * Works out what an edit does to the listing's setup, without writing anything yet. The inputs, requirements and setup link are
 * what people see and what gets sent, so changing them needs the team to look again; the credentials and the notes for the team
 * are the owner's own business and change freely. A saved key is only replaced when a new one is sent.
 */
async function planConfigUpdate(l: Listing, b: Record<string, unknown>): Promise<Planned> {
  if (!CONFIG_KEYS.some((k) => k in b)) return NOTHING;
  const [existing] = await db.select().from(providerConfigs).where(eq(providerConfigs.listingId, l.id)).limit(1);
  const next = {
    inputFields: existing?.inputFields ?? null,
    requirements: existing?.requirements ?? null,
    setupUrl: existing?.setupUrl ?? null,
    teamNotes: existing?.teamNotes ?? null,
    authType: existing?.authType ?? "none",
    authHeader: existing?.authHeader ?? null,
    authSecretEnc: existing?.authSecretEnc ?? null,
  };
  let changed = false;
  let reviewNeeded = false;

  if ("inputFields" in b) {
    const r = normalizeInputFields(b.inputFields);
    if (!r.ok) return { ok: false, status: 400, error: r.error };
    const text = r.value ? JSON.stringify(r.value) : null;
    if (text !== next.inputFields) { next.inputFields = text; changed = true; reviewNeeded = true; }
  }
  if ("requirements" in b) {
    const r = normalizeRequirements(b.requirements);
    if (!r.ok) return { ok: false, status: 400, error: r.error };
    const text = r.value ? JSON.stringify(r.value) : null;
    if (text !== next.requirements) { next.requirements = text; changed = true; reviewNeeded = true; }
  }
  if ("setupUrl" in b) {
    const r = normalizeSetupUrl(b.setupUrl);
    if (!r.ok) return { ok: false, status: 400, error: r.error };
    if (r.value !== next.setupUrl) { next.setupUrl = r.value; changed = true; reviewNeeded = true; }
  }
  if ("teamNotes" in b) {
    const r = normalizeTeamNotes(b.teamNotes);
    if (!r.ok) return { ok: false, status: 400, error: r.error };
    if (r.value !== next.teamNotes) { next.teamNotes = r.value; changed = true; }
  }
  if ("auth" in b) {
    const copied = await resolveCopiedSecret(l.ownerUserId, b.auth);
    if (!copied.ok) return { ok: false, status: copied.status, error: copied.error };
    const r = validateAuth(copied.auth, !!existing?.authSecretEnc);
    if (!r.ok) return { ok: false, status: 400, error: r.error };
    if (r.value.secret && !secretsEnabled()) {
      return { ok: false, status: 503, error: "Saving an API key isn’t switched on yet. Try again soon." };
    }
    const type = r.value.type;
    const header = r.value.header;
    const enc = type === "none" ? null : r.value.secret ? encryptSecret(r.value.secret, l.id) : next.authSecretEnc;
    if (type !== next.authType || header !== next.authHeader || r.value.secret || (enc === null) !== (next.authSecretEnc === null)) {
      next.authType = type;
      next.authHeader = header;
      next.authSecretEnc = enc;
      changed = true;
    }
  }
  if (!changed) return NOTHING;
  return {
    ok: true,
    changed: true,
    reviewNeeded,
    apply: async () => {
      await db.insert(providerConfigs).values({ listingId: l.id, ...next }).onConflictDoUpdate({ target: providerConfigs.listingId, set: { ...next, updatedAt: sql`now()` } });
    },
  };
}

/** Works out what an edit does to the owner's own terms. Changing them (or adding or removing them) needs the team to look again. */
async function planTermsUpdate(l: Listing, b: Record<string, unknown>): Promise<Planned> {
  if (!("customTerms" in b)) return NOTHING;
  const r = normalizeCustomTerms(b.customTerms);
  if (!r.ok) return { ok: false, status: 400, error: r.error };
  const [existing] = await db.select().from(providerTerms).where(eq(providerTerms.listingId, l.id)).limit(1);
  const next = r.value;
  if (!next && !existing) return NOTHING;
  if (next && existing && termsHash(next) === existing.termsHash) return NOTHING;
  return {
    ok: true,
    changed: true,
    reviewNeeded: true,
    apply: async () => {
      if (!next) {
        await db.delete(providerTerms).where(eq(providerTerms.listingId, l.id));
        return;
      }
      const row = { listingId: l.id, termsText: next.text, termsUrl: next.url, termsHash: termsHash(next) };
      await db.insert(providerTerms).values(row).onConflictDoUpdate({ target: providerTerms.listingId, set: { termsText: row.termsText, termsUrl: row.termsUrl, termsHash: row.termsHash, updatedAt: sql`now()` } });
    },
  };
}

/**
 * An owner edits their listing. Changing what people see or what gets called (name, description, category, endpoint, docs link,
 * price, request inputs, requirements, setup link) sends it back to the team, so a live listing can't be quietly turned into
 * something else; the example request, payout wallet, credentials and notes for the team change freely. (Who you are and your contact email live on your creator profile.)
 * Compare-and-set on the status, so an edit racing a team decision can't overwrite it.
 *
 * The listing row is written FIRST (it carries the status change), then the setup and terms records: if one of those later
 * writes fails, the listing has already gone back for review, which is the safe direction.
 */
export async function updateListing(userId: string, id: string, body: unknown) {
  const l = await getListing(id);
  if (!l || l.ownerUserId !== userId || l.status === "removed") return { ok: false as const, status: 404, error: "Provider not found." };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false as const, status: 400, error: "Send the changes as an object." };
  const b = body as Record<string, unknown>;

  let listingChanges: ListingChanges = {};
  let reviewNeeded = false;
  const checked = validateListingUpdate(b, {
    name: l.name, summary: l.summary, category: l.category, endpointUrl: l.endpointUrl, docsUrl: l.docsUrl,
    priceUsdc: l.priceUsdc, payoutWallet: l.payoutWallet, exampleRequest: l.exampleRequest,
  });
  if (checked.ok) {
    listingChanges = checked.changes;
    reviewNeeded = checked.reviewNeeded;
  } else if (checked.error !== NOTHING_TO_CHANGE) {
    return { ok: false as const, status: 400, error: checked.error };
  }

  const config = await planConfigUpdate(l, b);
  if (!config.ok) return config;
  const terms = await planTermsUpdate(l, b);
  if (!terms.ok) return terms;

  const listingChanged = Object.keys(listingChanges).length > 0;
  if (!listingChanged && !config.changed && !terms.changed) return { ok: false as const, status: 400, error: NOTHING_TO_CHANGE };
  reviewNeeded = reviewNeeded || config.reviewNeeded || terms.reviewNeeded;

  const plan = editPlan({ status: l.status, pausedByOwner: l.pausedByOwner, verifiedAt: l.verifiedAt }, reviewNeeded);
  if (!plan.ok) return plan;
  let current = l;
  if (listingChanged || plan.clearReview) {
    const [row] = await db.update(providerListings)
      .set({
        ...listingChanges,
        status: plan.status,
        pausedByOwner: plan.pausedByOwner,
        updatedAt: sql`now()`,
        ...(plan.clearReview ? { reviewNote: null, verifiedAt: null, featured: false, featuredAt: null } : {}),
      })
      .where(and(eq(providerListings.id, id), eq(providerListings.ownerUserId, userId), eq(providerListings.status, l.status))).returning();
    if (!row) return { ok: false as const, status: 409, error: "This provider changed while you were editing. Reload and try again." };
    current = row;
  }
  await config.apply();
  await terms.apply();
  return { ok: true as const, listing: { id: current.id, status: current.status }, sentForReview: plan.clearReview === true, wasLive: l.status === "verified" && plan.clearReview === true };
}

/** An owner pauses, resumes or removes their listing. Removing hides it everywhere but keeps its usage and earnings history. */
export async function ownerAction(userId: string, id: string, action: unknown) {
  const l = await getListing(id);
  if (!l || l.ownerUserId !== userId) return { ok: false as const, status: 404, error: "Provider not found." };
  const plan = ownerActionPlan({ status: l.status, pausedByOwner: l.pausedByOwner, verifiedAt: l.verifiedAt }, action);
  if (!plan.ok) return plan;
  const [row] = await db.update(providerListings)
    .set({
      status: plan.status,
      pausedByOwner: plan.pausedByOwner,
      updatedAt: sql`now()`,
      ...(plan.status !== "verified" ? { featured: false, featuredAt: null } : {}),
      ...(plan.status === "removed" ? { removedAt: sql`now()` } : {}),
    })
    .where(and(eq(providerListings.id, id), eq(providerListings.ownerUserId, userId), eq(providerListings.status, l.status))).returning();
  if (!row) return { ok: false as const, status: 409, error: "This provider changed just now. Reload and try again." };
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
export async function recordUsage(
  listing: Pick<Listing, "id" | "ownerUserId">,
  callerUserId: string,
  amountUsdc = "0",
  settlementRef: string | null = null,
  /** A paid call: what was charged and how it splits. The usage row and the owner's commission are written together. */
  paid?: { micro: number; owner: number; platform: number },
) {
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
  // Two accounts on the same phone are one person: using your own provider from a second account earns nothing.
  if (shar > 0 && (await sharesDevice(callerUserId, listing.ownerUserId))) shar = 0;
  if (paid && paid.micro > 0) {
    // One statement: the usage row and the owner's commission land together or not at all.
    await db.execute(sql`
      with u as (
        insert into provider_usage (listing_id, caller_user_id, amount_usdc, shar, settlement_ref, paid_micro, owner_micro, platform_micro)
        values (${listing.id}::uuid, ${callerUserId}, ${amountUsdc}, ${shar}, ${settlementRef}, ${paid.micro}, ${paid.owner}, ${paid.platform})
        returning owner_micro
      )
      insert into earnings_balances (user_id, available_micro, lifetime_micro)
      select ${listing.ownerUserId}, owner_micro, owner_micro from u
      on conflict (user_id) do update
        set available_micro = earnings_balances.available_micro + excluded.available_micro,
            lifetime_micro = earnings_balances.lifetime_micro + excluded.lifetime_micro,
            updated_at = now()`);
    return { shar };
  }
  await db.insert(providerUsage).values({ listingId: listing.id, callerUserId, amountUsdc, shar, settlementRef });
  return { shar };
}

// ── One call, free or paid ────────────────────────────────────────────────────

export type CallOutcome =
  | { ok: true; providerStatus: number; data: unknown; chargedMicro: number; balanceMicro: number | null }
  | { ok: false; status: number; error: string; code?: "insufficient_credits" | "terms_required"; requiredMicro?: number; balanceMicro?: number };

/**
 * Runs one call to a verified provider for `callerUserId`.
 *  • Free listing, or the owner testing their own: just call it.
 *  • Paid listing: take the price from the caller's credits first (atomically), call the provider, and
 *      - if the provider fails (error, timeout, non-2xx), give the credits back: the caller is never charged for a failure;
 *      - if it succeeds, settle: the owner earns 80%, Bluvfi keeps 20%, and the usage row carries the debit's id.
 * `call` is injectable so tests can simulate any provider behaviour.
 */
export async function runProviderCall(
  listing: Listing,
  callerUserId: string,
  payload: unknown,
  call: (l: Listing, p: unknown) => Promise<GatewayResult> = callProvider,
): Promise<CallOutcome> {
  const priceMicro = usdToMicro(listing.priceUsdc);
  if (priceMicro === null || !isValidPriceMicro(priceMicro)) return { ok: false, status: 500, error: "This provider's price is invalid." };

  // The owner's own terms: anyone but the owner has to have agreed to THIS version first. Refused before anything is charged or sent.
  const gate = await termsGate(listing, callerUserId);
  if (!gate.ok) return gate;

  // The provider may list the inputs it needs. A request that doesn't fit them is refused here, before anything is charged or sent.
  const input = await checkCallInput(listing.id, payload);
  if (!input.ok) return { ok: false, status: 400, error: input.error };
  payload = input.payload;

  const owner = callerUserId === listing.ownerUserId;
  if (priceMicro === 0 || owner) {
    const res = await call(listing, payload);
    if (!res.ok) return { ok: false, status: res.status, error: res.error };
    const free = res;
    if (free.status >= 200 && free.status < 300) await recordUsage(listing, callerUserId);
    return { ok: true, providerStatus: free.status, data: free.body, chargedMicro: 0, balanceMicro: null };
  }

  const debit = await debitForCall(callerUserId, listing.id, priceMicro);
  if (!debit.ok) {
    return {
      ok: false,
      status: 402,
      code: "insufficient_credits",
      error: `This call costs $${microToDecimal(priceMicro)}. Add credits to use it.`,
      requiredMicro: priceMicro,
      balanceMicro: debit.balanceMicro,
    };
  }

  let res: GatewayResult;
  try {
    res = await call(listing, payload);
  } catch {
    res = { ok: false, status: 502, error: "The provider didn't answer." };
  }
  if (!res.ok || res.status < 200 || res.status >= 300) {
    await refundCall(callerUserId, debit.ledgerId, priceMicro);
    const reason = res.ok ? `The provider answered with an error (${res.status}).` : res.error;
    return { ok: false, status: res.ok ? 502 : res.status, error: `${reason} You weren't charged.` };
  }

  const split = splitPrice(priceMicro);
  await recordUsage(listing, callerUserId, microToDecimal(priceMicro), debit.ledgerId, { micro: priceMicro, owner: split.owner, platform: split.platform });
  return { ok: true, providerStatus: res.status, data: res.body, chargedMicro: priceMicro, balanceMicro: debit.balanceMicro };
}

export { getBalanceMicro };

/**
 * Resolves a provider's host ONCE and returns the address to connect to, or null when it must not be called.
 * Every address the host resolves to must be public (one private address among several refuses the host), and this is checked on
 * every call, not just when the listing was submitted. The caller connects to the returned address and never looks the host up
 * again, so the host can't answer differently between the check and the call (DNS rebinding).
 */
export async function resolvePublicAddress(host: string): Promise<{ address: string; family: 4 | 6 } | null> {
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0 || !addrs.every((a) => isPublicIp(a.address))) return null;
    return { address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 };
  } catch {
    return null;
  }
}

export async function assertResolvesPublic(host: string): Promise<boolean> {
  return (await resolvePublicAddress(host)) !== null;
}

export type GatewayResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

/**
 * Calls a verified provider with the caller's JSON. The host is resolved once and checked, then the connection is pinned to
 * that exact address (see pinned-request.ts): no second lookup, no redirects, a short deadline and a capped response.
 * `transport` is injectable so tests can simulate any provider behaviour.
 */
export async function callProvider(
  listing: Listing,
  payload: unknown,
  transport: typeof pinnedPost = pinnedPost,
  loadAuth: typeof loadProviderAuth = loadProviderAuth,
): Promise<GatewayResult> {
  const url = safePublicUrl(listing.endpointUrl);
  const target = url ? await resolvePublicAddress(url.hostname) : null;
  if (!url || !target) return { ok: false, status: 502, error: "This provider can't be reached right now." };
  const bodyText = JSON.stringify(payload ?? {});
  if (bodyText.length > NETWORK.maxRequestBytes) return { ok: false, status: 413, error: "Request too large." };
  // The key the owner saved for their API, if any. Refuses (never sends without it) when it is set up but can't be read.
  const auth = await loadAuth(listing.id);
  if (!auth.ok) return { ok: false, status: 502, error: "This provider isn't set up correctly right now." };
  try {
    const res = await transport({
      url,
      address: target.address,
      family: target.family,
      body: bodyText,
      // The credential goes first so it can never override the headers Bluvfi sets itself.
      headers: { ...(auth.header ? { [auth.header.name]: auth.header.value } : {}), "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Bluvfi-Provider-Gateway/1.0", "X-Bluvfi-Listing": listing.id },
      timeoutMs: NETWORK.callTimeoutMs,
      maxBytes: NETWORK.maxResponseBytes,
    });
    if (res.status >= 300 && res.status < 400) return { ok: false, status: 502, error: "The provider tried to redirect, which isn't allowed." };
    if (res.truncated) return { ok: false, status: 502, error: "The provider's response was too large." };
    const text = new TextDecoder().decode(res.body);
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
