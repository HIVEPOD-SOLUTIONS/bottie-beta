/**
 * Narrow Solana RPC proxy for the Android app's Seeker features (Seeker Genesis Token badge, .skr names).
 *
 * Why it exists: the app used to carry an RPC key (EXPO_PUBLIC_*), and anything compiled into an APK can be read out of
 * it. With this proxy the key lives only in the server's HELIUS_RPC_URL, and the app calls /api/solana/rpc with its
 * Privy token. An open JSON-RPC relay would be abused, so only the exact requests the app makes are allowed.
 */

/** AllDomains' name service program: where `.skr` names live. */
export const ANS_PROGRAM = "ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK";
/** Token-2022: the Seeker Genesis Token is a Token-2022 mint. */
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const MAX_BODY_BYTES = 8_192;
export const MAX_RESPONSE_BYTES = 1_000_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const MAX_MULTIPLE_ACCOUNTS = 100;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isKey = (v: unknown): v is string => typeof v === "string" && BASE58.test(v);

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: unknown[];
}

type Validation = { ok: true; request: RpcRequest } | { ok: false; error: string };
const bad = (error: string): Validation => ({ ok: false, error });

/** Only these option keys, and only these encodings, ever reach the upstream. */
function checkConfig(config: unknown, allowedKeys: string[]): string | null {
  if (config === undefined) return null;
  if (!isObject(config)) return "Invalid options";
  for (const key of Object.keys(config)) {
    if (!allowedKeys.includes(key)) return `Option not allowed: ${key}`;
  }
  const enc = config.encoding;
  if (enc !== undefined && enc !== "base64" && enc !== "jsonParsed") return "Encoding not allowed";
  return null;
}

/**
 * Accepts exactly the calls the app makes:
 *  - getAccountInfo(address, {encoding})
 *  - getMultipleAccounts(≤100 addresses, {encoding})
 *  - getTokenAccountsByOwner(owner, {programId: Token-2022}, {encoding})          (Seeker Genesis Token)
 *  - getProgramAccounts(ANS program, {encoding, dataSlice ≤ 8 bytes, ≥ 2 memcmp filters})   (.skr names)
 * Anything else, including batches and every other program, is refused.
 */
export function validateRpcRequest(input: unknown): Validation {
  if (!isObject(input)) return bad("Send a single JSON-RPC request");
  if (input.jsonrpc !== "2.0") return bad("jsonrpc must be 2.0");
  const id = input.id ?? 1;
  if (typeof id !== "number" && typeof id !== "string") return bad("Invalid id");
  if (typeof input.method !== "string") return bad("Missing method");
  const params = input.params;
  if (!Array.isArray(params)) return bad("params must be an array");
  const method = input.method;
  const ok: Validation = { ok: true, request: { jsonrpc: "2.0", id, method, params } };

  switch (method) {
    case "getAccountInfo": {
      if (!isKey(params[0])) return bad("Invalid address");
      const err = checkConfig(params[1], ["encoding", "commitment"]);
      return err ? bad(err) : params.length > 2 ? bad("Too many params") : ok;
    }
    case "getMultipleAccounts": {
      const keys = params[0];
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_MULTIPLE_ACCOUNTS || !keys.every(isKey)) {
        return bad("Invalid address list");
      }
      const err = checkConfig(params[1], ["encoding", "commitment"]);
      return err ? bad(err) : params.length > 2 ? bad("Too many params") : ok;
    }
    case "getTokenAccountsByOwner": {
      if (!isKey(params[0])) return bad("Invalid owner");
      const filter = params[1];
      if (!isObject(filter) || Object.keys(filter).length !== 1 || filter.programId !== TOKEN_2022_PROGRAM) {
        return bad("Only Token-2022 accounts can be listed");
      }
      const err = checkConfig(params[2], ["encoding", "commitment"]);
      return err ? bad(err) : params.length > 3 ? bad("Too many params") : ok;
    }
    case "getProgramAccounts": {
      if (params[0] !== ANS_PROGRAM) return bad("Program not allowed");
      const config = params[1];
      const err = checkConfig(config, ["encoding", "dataSlice", "filters", "commitment"]);
      if (err) return bad(err);
      if (!isObject(config)) return bad("Options required");
      const slice = config.dataSlice;
      if (!isObject(slice) || typeof slice.offset !== "number" || typeof slice.length !== "number" || slice.length < 0 || slice.length > 8) {
        return bad("dataSlice required (8 bytes at most)");
      }
      const filters = config.filters;
      if (!Array.isArray(filters) || filters.length < 2 || filters.length > 3) return bad("Filters required");
      for (const f of filters) {
        const m = isObject(f) && isObject(f.memcmp) ? f.memcmp : null;
        if (!m || typeof m.offset !== "number" || !isKey(m.bytes) || (m.encoding !== undefined && m.encoding !== "base58")) {
          return bad("Only address filters are allowed");
        }
      }
      return params.length > 2 ? bad("Too many params") : ok;
    }
    default:
      return bad("Method not allowed");
  }
}

export type ForwardResult = { status: number; body: string };

/** Sends a validated request upstream. Never returns upstream URLs, keys or stack traces. */
export async function forwardRpc(upstreamUrl: string, request: RpcRequest): Promise<ForwardResult> {
  try {
    const res = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return { status: 502, body: JSON.stringify({ error: "Response too large" }) };
    }
    // A JSON-RPC error (rate limit, bad params) still comes back as a normal JSON body; only transport failures are 502.
    try {
      JSON.parse(text);
    } catch {
      return { status: 502, body: JSON.stringify({ error: "Solana RPC is unavailable" }) };
    }
    return { status: res.ok ? 200 : 502, body: text };
  } catch {
    return { status: 502, body: JSON.stringify({ error: "Solana RPC is unavailable" }) };
  }
}
