import { createHash } from "node:crypto";
import { safePublicUrl } from "@/lib/provider-network-rules";

/**
 * An owner's own terms for the people who use their provider. These sit ON TOP of Bluvfi's Terms of Service (which always apply) and
 * the platform's provider terms; the team can decline or remove a listing whose terms break Bluvfi's rules. No database access here.
 *
 * What people agree to is a specific VERSION: the fingerprint below covers the text and the link, so changing either asks everyone again.
 */

export const TERMS = {
  textMax: 2_000,
  textMin: 20,
  /** Header an outside agent sends to accept the terms it was shown (x402 callers have no account to click a checkbox in). */
  agentHeader: "x-bluvfi-terms",
} as const;

export interface CustomTerms {
  text: string | null;
  url: string | null;
}

// eslint-disable-next-line no-control-regex
const BAD_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** The terms sent with a listing or an edit: text and/or a public https link, or nothing (null). Line breaks in the text are kept. */
export function normalizeCustomTerms(raw: unknown): { ok: true; value: CustomTerms | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The terms aren’t valid." };
  const b = raw as Record<string, unknown>;

  let text: string | null = null;
  if (b.text !== undefined && b.text !== null && b.text !== "") {
    if (typeof b.text !== "string") return { ok: false, error: "The terms must be text." };
    const t = b.text.replace(/\r\n/g, "\n").trim();
    if (BAD_CONTROL.test(t)) return { ok: false, error: "The terms contain characters we can’t store." };
    if (t.length > TERMS.textMax) return { ok: false, error: `Keep your terms under ${TERMS.textMax} characters, or put the full terms behind a link.` };
    if (t.length > 0 && t.length < TERMS.textMin) return { ok: false, error: `Your terms are too short to mean anything (at least ${TERMS.textMin} characters), or just add a link.` };
    text = t || null;
  }

  let url: string | null = null;
  if (b.url !== undefined && b.url !== null && b.url !== "") {
    const u = safePublicUrl(b.url);
    if (!u) return { ok: false, error: "The link to your terms must be a public https:// address." };
    url = u.toString();
  }
  return { ok: true, value: text || url ? { text, url } : null };
}

/** A short fingerprint of one version of the terms. Stable, and different whenever the text or the link is. */
export function termsHash(t: CustomTerms): string {
  return createHash("sha256").update(`${t.text ?? ""}\n${t.url ?? ""}`).digest("hex").slice(0, 16);
}

/** Whether a header value from an outside agent accepts these terms. Exact match only. */
export const agentAccepts = (header: string | null | undefined, hash: string): boolean => typeof header === "string" && header.trim() === hash;
