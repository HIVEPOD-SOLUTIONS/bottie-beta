/**
 * GetEquity member provisioning — one real GetEquity account per Bluvfi user, created lazily
 * the first time they do something that needs one, and cached locally afterwards so every later
 * call is a free lookup instead of another GetEquity round-trip.
 *
 * Bluvfi has no KYC-level profile data (dob, phone, address, ...) stored anywhere — see
 * src/lib/db/schema.ts — so those fields must come from the user, for real, on first use. This
 * module never fabricates them: ensureGetEquityMember() throws GetEquityProfileRequiredError
 * when they're missing, which callers (the AI tool / the UI) surface as "collect these fields
 * from the user" rather than silently failing or making something up.
 *
 * Passwords are never chosen by, shown to, or stored by Bluvfi: GetEquity requires one to create
 * a member, so this generates a throwaway random one, sends it once, and discards it. Bluvfi
 * users only ever act on the account through Bluvfi anyway (see getequity.ts's module comment);
 * if someone wants to log into GetEquity directly later, GetEquity's own password reset (by
 * email) is the path, not a password Bluvfi remembers.
 */

import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getequityMembers } from "@/lib/db/schema";
import { createMember, getMemberByEmail, type CreateMemberInput } from "@/lib/getequity";

export class GetEquityProfileRequiredError extends Error {
  constructor() {
    super(
      "This person doesn't have a GetEquity account yet, and opening one needs details Bluvfi " +
      "doesn't have on file: full name, phone, date of birth, sex, and home address (address, city, state, country). " +
      "Collect these from the user in the conversation, then call getequity_create_member (or retry with a profile).",
    );
    this.name = "GetEquityProfileRequiredError";
  }
}

export type GetEquityProfile = Omit<CreateMemberInput, "password">;

function generateThrowawayPassword() {
  // GetEquity requires a password (max 30 chars) but Bluvfi never uses it — the organisation
  // secret key authenticates every call on the member's behalf. Generate, send once, discard.
  return randomBytes(18).toString("base64url").slice(0, 24);
}

/**
 * Returns the memberId for this Bluvfi user, creating the GetEquity account on first call.
 *
 * - Local mapping exists → returns it immediately, no GetEquity call.
 * - No mapping, but GetEquity already has an account for `profile.email` → links it (GetEquity's
 *   own dedup: creating with an existing email reuses that account rather than duplicating it).
 * - No mapping, no existing account, and no `profile` given → throws GetEquityProfileRequiredError.
 * - No mapping, no existing account, `profile` given → creates a real member and caches it.
 */
export async function ensureGetEquityMember(
  userId: string,
  profile?: GetEquityProfile,
): Promise<{ memberId: string; created: boolean }> {
  const [existing] = await db
    .select()
    .from(getequityMembers)
    .where(eq(getequityMembers.userId, userId))
    .limit(1);
  if (existing) return { memberId: existing.memberId, created: false };

  if (!profile) throw new GetEquityProfileRequiredError();

  // Check GetEquity itself before creating — an existing account for this email is linked by
  // GetEquity automatically on createMember too, but checking first avoids sending a fresh
  // throwaway password/DOB/etc. for an account this person may already hold.
  let memberId: string | undefined;
  const found: any = await getMemberByEmail(profile.email).catch(() => null);
  if (found?.data?._id) {
    memberId = found.data._id;
  } else {
    const created: any = await createMember({ ...profile, password: generateThrowawayPassword() });
    memberId = created?.data?._id;
  }
  if (!memberId) throw new Error("GetEquity did not return a member id");

  await db
    .insert(getequityMembers)
    .values({ userId, memberId, email: profile.email })
    .onConflictDoUpdate({
      target: getequityMembers.userId,
      set: { memberId, email: profile.email },
    });

  return { memberId, created: true };
}

/** Local-only lookup — never calls GetEquity. Returns null if this user has no member yet. */
export async function getCachedGetEquityMemberId(userId: string): Promise<string | null> {
  const [existing] = await db
    .select()
    .from(getequityMembers)
    .where(eq(getequityMembers.userId, userId))
    .limit(1);
  return existing?.memberId ?? null;
}
