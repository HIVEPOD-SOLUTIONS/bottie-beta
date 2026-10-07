import { safePublicUrl } from "@/lib/provider-network-rules";

/**
 * How a provider is set up beyond its listing: the inputs a caller fills in, what a person must do before using it, how Bluvfi
 * authenticates to the owner's API, and private notes for the Bluvfi team. No database access here.
 *
 * What is PUBLIC (shown to anyone who can open the provider): the input fields, the requirements and the setup link.
 * What is PRIVATE: the credentials and the team notes. A credential is never returned by any endpoint once saved.
 */

export const CONFIG = {
  maxFields: 12,
  keyMax: 32,
  labelMax: 40,
  helpMax: 120,
  placeholderMax: 60,
  maxChoices: 10,
  choiceMax: 30,
  textValueMax: 500,
  maxRequirements: 5,
  requirementMin: 5,
  requirementMax: 140,
  teamNotesMax: 500,
  headerMax: 40,
  secretMax: 500,
} as const;

export const FIELD_TYPES = ["text", "number", "boolean", "choice"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface InputField {
  /** The JSON property sent to the provider: letters, digits and underscores, starting with a letter. */
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  help: string | null;
  placeholder: string | null;
  /** Only for type "choice": the allowed values. */
  choices: string[] | null;
  /** Used when an optional field is left empty. Matches `type`. */
  default: string | number | boolean | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const tidy = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const present = (v: unknown) => v !== undefined && v !== null && v !== "";

// ── Input fields ──────────────────────────────────────────────────────────────

/**
 * Checks the owner's list of input fields. Returns the normalised list, or null when there are none (an empty list means
 * "free-form JSON", like before).
 */
export function normalizeInputFields(raw: unknown): { ok: true; value: InputField[] | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, error: "The request inputs must be a list." };
  if (raw.length === 0) return { ok: true, value: null };
  if (raw.length > CONFIG.maxFields) return { ok: false, error: `Add up to ${CONFIG.maxFields} request inputs.` };

  const out: InputField[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    const at = `Input ${i + 1}`;
    if (typeof f !== "object" || f === null || Array.isArray(f)) return { ok: false, error: `${at} is not valid.` };
    const b = f as Record<string, unknown>;

    const key = typeof b.key === "string" ? b.key.trim() : "";
    if (!KEY.test(key)) return { ok: false, error: `${at}: the name must start with a letter and use only letters, numbers and underscores (up to ${CONFIG.keyMax}).` };
    if (seen.has(key.toLowerCase())) return { ok: false, error: `${at}: “${key}” is used twice. Each input needs its own name.` };
    seen.add(key.toLowerCase());

    const label = tidy(b.label);
    if (label.length < 1 || label.length > CONFIG.labelMax || CONTROL.test(label)) return { ok: false, error: `${at}: give it a label (up to ${CONFIG.labelMax} characters).` };
    if (!FIELD_TYPES.includes(b.type as FieldType)) return { ok: false, error: `${at}: pick a type (text, number, yes/no or choice).` };
    const type = b.type as FieldType;

    const help = present(b.help) ? tidy(b.help) : "";
    if (help.length > CONFIG.helpMax || CONTROL.test(help)) return { ok: false, error: `${at}: the help text is too long (up to ${CONFIG.helpMax} characters).` };
    const placeholder = present(b.placeholder) ? tidy(b.placeholder) : "";
    if (placeholder.length > CONFIG.placeholderMax || CONTROL.test(placeholder)) return { ok: false, error: `${at}: the example text is too long (up to ${CONFIG.placeholderMax} characters).` };

    let choices: string[] | null = null;
    if (type === "choice") {
      const list = Array.isArray(b.choices) ? b.choices.map(tidy).filter(Boolean) : [];
      if (list.length < 2 || list.length > CONFIG.maxChoices) return { ok: false, error: `${at}: a choice needs 2–${CONFIG.maxChoices} options.` };
      if (list.some((c) => c.length > CONFIG.choiceMax || CONTROL.test(c))) return { ok: false, error: `${at}: each option can be up to ${CONFIG.choiceMax} characters.` };
      if (new Set(list.map((c) => c.toLowerCase())).size !== list.length) return { ok: false, error: `${at}: the options must all be different.` };
      choices = list;
    }

    let def: InputField["default"] = null;
    if (present(b.default)) {
      const d = b.default;
      if (type === "text" && typeof d === "string" && d.length <= CONFIG.textValueMax && !CONTROL.test(d)) def = d;
      else if (type === "number" && typeof d === "number" && Number.isFinite(d)) def = d;
      else if (type === "boolean" && typeof d === "boolean") def = d;
      else if (type === "choice" && typeof d === "string" && choices!.includes(d)) def = d;
      else return { ok: false, error: `${at}: the starting value doesn’t match its type.` };
    }

    out.push({ key, label, type, required: b.required === true, help: help || null, placeholder: placeholder || null, choices, default: def });
  }
  return { ok: true, value: out };
}

/**
 * Checks a caller's request against the provider's input fields BEFORE anything is charged or sent. Required fields must be
 * filled and each value must match its type; missing optional fields take their starting value. Extra properties are allowed
 * (the raw JSON option), so a provider can accept more than it lists.
 */
export function validateCallInput(fields: InputField[] | null, payload: unknown): { ok: true; payload: unknown } | { ok: false; error: string } {
  // No inputs defined: free-form JSON, passed through exactly as sent (as it always was).
  if (!fields || fields.length === 0) return { ok: true, payload };
  const body = payload === undefined || payload === null ? {} : payload;
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send the request as a JSON object." };
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };

  for (const f of fields) {
    const v = out[f.key];
    const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (empty) {
      if (f.default !== null) {
        out[f.key] = f.default;
        continue;
      }
      if (f.required) return { ok: false, error: `“${f.label}” is required.` };
      delete out[f.key];
      continue;
    }
    switch (f.type) {
      case "text":
        if (typeof v !== "string") return { ok: false, error: `“${f.label}” must be text.` };
        if (v.length > CONFIG.textValueMax) return { ok: false, error: `“${f.label}” is too long (up to ${CONFIG.textValueMax} characters).` };
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `“${f.label}” must be a number.` };
        break;
      case "boolean":
        if (typeof v !== "boolean") return { ok: false, error: `“${f.label}” must be yes or no.` };
        break;
      case "choice":
        if (typeof v !== "string" || !f.choices!.includes(v)) return { ok: false, error: `“${f.label}” must be one of: ${f.choices!.join(", ")}.` };
        break;
    }
  }
  return { ok: true, payload: out };
}

/** A starting request built from the fields (for the example shown on the provider page). */
export function exampleFromFields(fields: InputField[] | null): Record<string, unknown> | null {
  if (!fields || fields.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    out[f.key] = f.default ?? (f.type === "number" ? 0 : f.type === "boolean" ? false : f.type === "choice" ? f.choices![0] : (f.placeholder ?? ""));
  }
  return out;
}

// ── Requirements and setup link ───────────────────────────────────────────────

/** What a person has to do before they can use the provider: up to five short steps. Empty means none. */
export function normalizeRequirements(raw: unknown): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, error: "The requirements must be a list." };
  const list = raw.map(tidy).filter(Boolean);
  if (list.length === 0) return { ok: true, value: null };
  if (list.length > CONFIG.maxRequirements) return { ok: false, error: `List up to ${CONFIG.maxRequirements} requirements.` };
  if (list.some((r) => r.length < CONFIG.requirementMin || r.length > CONFIG.requirementMax || CONTROL.test(r))) {
    return { ok: false, error: `Each requirement should be ${CONFIG.requirementMin}–${CONFIG.requirementMax} characters.` };
  }
  return { ok: true, value: list };
}

export function normalizeSetupUrl(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!present(raw)) return { ok: true, value: null };
  const u = safePublicUrl(raw);
  if (!u) return { ok: false, error: "The setup link must be a public https:// address." };
  return { ok: true, value: u.toString() };
}

/** Private notes for the Bluvfi team (never shown to other users). */
export function normalizeTeamNotes(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!present(raw)) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "The notes for the team must be text." };
  const text = raw.trim();
  if (text.length > CONFIG.teamNotesMax) return { ok: false, error: `Keep the notes for the team under ${CONFIG.teamNotesMax} characters.` };
  // keep line breaks, drop other control characters
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { ok: false, error: "The notes contain characters we can’t store." };
  return { ok: true, value: text || null };
}

// ── How Bluvfi authenticates to the owner's API ───────────────────────────────

export const AUTH_TYPES = ["none", "header", "bearer"] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** Headers Bluvfi sets itself (or that would change how the request is framed): a provider can't ask us to override them. */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "accept", "user-agent", "connection", "transfer-encoding", "te", "upgrade", "expect",
  "proxy-authorization", "proxy-authenticate", "cookie", "set-cookie", "trailer", "keep-alive", "via", "forwarded",
]);
const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export interface AuthInput {
  type: AuthType;
  /** For type "header": the header name, e.g. X-API-Key. Bearer always uses Authorization. */
  header: string | null;
  /** The key itself. Absent when it is unchanged (an edit) or the type is "none". */
  secret: string | null;
}

/**
 * Checks the credential settings. `hasSecret` says whether one is already saved, so an edit can change the type or header
 * without re-entering the key. Switching to "none" clears the key.
 */
export function validateAuth(raw: unknown, hasSecret = false): { ok: true; value: AuthInput } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: { type: "none", header: null, secret: null } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The connection settings aren’t valid." };
  const b = raw as Record<string, unknown>;
  if (!AUTH_TYPES.includes(b.type as AuthType)) return { ok: false, error: "Pick how Bluvfi should connect: no key, an API-key header, or a bearer token." };
  const type = b.type as AuthType;
  if (type === "none") return { ok: true, value: { type, header: null, secret: null } };

  let header: string | null = null;
  if (type === "header") {
    const name = typeof b.header === "string" ? b.header.trim() : "";
    if (!name || name.length > CONFIG.headerMax || !HEADER_TOKEN.test(name)) return { ok: false, error: "Enter the header name your API expects, like X-API-Key." };
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower) || lower.startsWith("x-bluvfi-")) return { ok: false, error: `“${name}” is used by Bluvfi itself. Pick another header name.` };
    header = name;
  } else {
    header = "Authorization";
  }

  let secret: string | null = null;
  if (present(b.secret)) {
    if (typeof b.secret !== "string") return { ok: false, error: "The key must be text." };
    const s = b.secret.trim();
    if (s.length < 1 || s.length > CONFIG.secretMax || CONTROL.test(s)) return { ok: false, error: `The key must be 1–${CONFIG.secretMax} characters with no line breaks.` };
    secret = s;
  }
  if (!secret && !hasSecret) return { ok: false, error: "Enter the key Bluvfi should send to your API." };
  return { ok: true, value: { type, header, secret } };
}

/** The header Bluvfi sends to the provider for a saved credential. */
export function authHeaderFor(type: AuthType, header: string | null, secret: string): { name: string; value: string } | null {
  if (type === "bearer") return { name: "Authorization", value: `Bearer ${secret}` };
  if (type === "header" && header) return { name: header, value: secret };
  return null;
}

// ── Everything together, for a new listing ────────────────────────────────────

export interface ConfigInput {
  inputFields: InputField[] | null;
  requirements: string[] | null;
  setupUrl: string | null;
  teamNotes: string | null;
  auth: AuthInput;
}

/** The configuration sent with a new listing. Everything is optional; whatever is sent must be valid. */
export function validateConfigInput(input: unknown): { ok: true; value: ConfigInput } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "Send the listing as an object." };
  const b = input as Record<string, unknown>;
  const fields = normalizeInputFields(b.inputFields);
  if (!fields.ok) return fields;
  const reqs = normalizeRequirements(b.requirements);
  if (!reqs.ok) return reqs;
  const setup = normalizeSetupUrl(b.setupUrl);
  if (!setup.ok) return setup;
  const notes = normalizeTeamNotes(b.teamNotes);
  if (!notes.ok) return notes;
  const auth = validateAuth(b.auth, false);
  if (!auth.ok) return auth;
  return { ok: true, value: { inputFields: fields.value, requirements: reqs.value, setupUrl: setup.value, teamNotes: notes.value, auth: auth.value } };
}
