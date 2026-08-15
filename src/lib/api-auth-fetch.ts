"use client";

type GetAccessToken = () => Promise<string | null>;

export class AuthTokenUnavailableError extends Error {
  constructor() {
    super("Privy access token is not available yet");
    this.name = "AuthTokenUnavailableError";
  }
}

export class AuthServiceUnavailableError extends Error {
  constructor() {
    super("Privy server authentication is not configured");
    this.name = "AuthServiceUnavailableError";
  }
}

let authServiceConfigured: boolean | undefined;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureAuthServiceConfigured() {
  if (authServiceConfigured !== undefined) {
    if (!authServiceConfigured) throw new AuthServiceUnavailableError();
    return;
  }

  try {
    const res = await fetch("/api/auth/status", {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const json = await res.json().catch(() => ({}));
    authServiceConfigured = json?.privyServerAuthConfigured === true;
  } catch {
    authServiceConfigured = true;
  }

  if (!authServiceConfigured) throw new AuthServiceUnavailableError();
}

async function getAccessTokenWithRetry(getAccessToken: GetAccessToken) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await getAccessToken();
    if (token) return token;
    await delay(100 * (attempt + 1));
  }
  throw new AuthTokenUnavailableError();
}

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  getAccessToken: GetAccessToken,
) {
  await ensureAuthServiceConfigured();
  const token = await getAccessTokenWithRetry(getAccessToken);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...(init ?? {}), headers });
}
