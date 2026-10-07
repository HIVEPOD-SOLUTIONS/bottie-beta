import { safePublicUrl } from "@/lib/provider-network-rules";

/**
 * Becoming a provider CREATOR is an opt-in sign-up (not every account can list providers): who is behind it (a person, or a company or
 * team), how to reach them, and agreement to Bluvfi's provider terms. No database access here.
 *
 * The terms text lives in the app (src/constants/provider-terms.ts there); the server only checks that the version the person
 * agreed to is the current one, so a change to the terms can't be accepted by an old copy of the app.
 */

/** Bump this (here AND in the app's src/constants/provider-terms.ts) whenever the terms change. */
export const PROVIDER_TERMS_VERSION = "2026-10-07";

export const PUBLISHER = {
  operatorTypes: ["individual", "company"] as const,
  companyMin: 2,
  companyMax: 80,
  emailMax: 120,
} as const;

export type OperatorType = (typeof PUBLISHER.operatorTypes)[number];

export interface PublisherInput {
  operatorType: OperatorType;
  companyName: string | null;
  companyWebsite: string | null;
  contactEmail: string;
  termsVersion: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface PublisherContact {
  operatorType: OperatorType;
  companyName: string | null;
  companyWebsite: string | null;
  contactEmail: string;
}

/** Who is behind it and how to reach them: the part of the answers that can change after submitting. */
export function validateContact(b: Record<string, unknown>): { ok: true; value: PublisherContact } | { ok: false; error: string } {
  const text = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

  if (!PUBLISHER.operatorTypes.includes(b.operatorType as OperatorType)) {
    return { ok: false, error: "Tell us whether you’re listing this as an individual or as a company or team." };
  }
  const operatorType = b.operatorType as OperatorType;

  let companyName: string | null = null;
  let companyWebsite: string | null = null;
  if (operatorType === "company") {
    const name = text(b.companyName);
    if (name.length < PUBLISHER.companyMin || name.length > PUBLISHER.companyMax || CONTROL.test(name)) {
      return { ok: false, error: `Enter your company or team name (${PUBLISHER.companyMin}–${PUBLISHER.companyMax} characters).` };
    }
    companyName = name;
    if (b.companyWebsite !== undefined && b.companyWebsite !== null && b.companyWebsite !== "") {
      const site = safePublicUrl(b.companyWebsite);
      if (!site) return { ok: false, error: "The company website must be a public https:// address." };
      companyWebsite = site.toString();
    }
  }

  const email = text(b.contactEmail).toLowerCase();
  if (email.length > PUBLISHER.emailMax || CONTROL.test(email) || !EMAIL.test(email)) {
    return { ok: false, error: "Enter an email address the team can reach you on." };
  }
  return { ok: true, value: { operatorType, companyName, companyWebsite, contactEmail: email } };
}

/** What a creator sign-up carries: who they are, how to reach them, and which version of the provider terms they agreed to. */
export interface CreatorInput extends PublisherContact {
  termsVersion: string;
}

/**
 * The sign-up to become a creator. Who they are and a contact email are required (a company name only for a company), and the provider
 * terms must be agreed to with an explicit `true`, for the CURRENT version (so an old copy of the app can't agree to old terms).
 */
export function validateCreatorSignup(input: unknown): { ok: true; value: CreatorInput } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "Send the sign-up as an object." };
  const b = input as Record<string, unknown>;
  const contact = validateContact(b);
  if (!contact.ok) return contact;
  if (b.termsAccepted !== true) return { ok: false, error: "Agree to the provider terms to become a creator." };
  if (b.termsVersion !== PROVIDER_TERMS_VERSION) {
    return { ok: false, error: "The provider terms have been updated. Open the sign-up again and read them before you agree." };
  }
  return { ok: true, value: { ...contact.value, termsVersion: PROVIDER_TERMS_VERSION } };
}

/** Every listing needs its own confirmation that the person owns the service or may offer it. An explicit `true`. */
export function validateRightsConfirmed(input: unknown): { ok: true } | { ok: false; error: string } {
  const b = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  return b.rightsConfirmed === true ? { ok: true } : { ok: false, error: "Confirm that you own this service or are allowed to offer it." };
}

export const CONTACT_KEYS = ["operatorType", "companyName", "companyWebsite", "contactEmail"] as const;

/**
 * A creator changing who they are or how to reach them. Free to change (no review). Anything not sent stays as it was; switching to an
 * individual drops the company details so they can't be left half-filled. Returns what changed, or "none" when nothing did.
 */
export function validateCreatorUpdate(
  input: unknown,
  current: PublisherContact,
): { ok: true; kind: "none" } | { ok: true; kind: "update"; value: PublisherContact; changed: Partial<PublisherContact> } | { ok: false; error: string } {
  const b = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  if (!CONTACT_KEYS.some((k) => k in b)) return { ok: true, kind: "none" };
  const merged: Record<string, unknown> = { ...current };
  for (const k of CONTACT_KEYS) if (k in b) merged[k] = b[k];
  if (merged.operatorType === "individual") {
    merged.companyName = null;
    merged.companyWebsite = null;
  }
  const checked = validateContact(merged);
  if (!checked.ok) return checked;
  const changed: Partial<PublisherContact> = {};
  for (const k of CONTACT_KEYS) {
    if (checked.value[k] !== current[k]) (changed as Record<string, unknown>)[k] = checked.value[k];
  }
  if (Object.keys(changed).length === 0) return { ok: true, kind: "none" };
  return { ok: true, kind: "update", value: checked.value, changed };
}
