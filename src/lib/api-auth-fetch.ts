"use client";

type GetAccessToken = () => Promise<string | null>;

export class AuthTokenUnavailableError extends Error {
  constructor() {
    super("Privy access token is not available yet");
    this.name = "AuthTokenUnavailableError";
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const token = await getAccessTokenWithRetry(getAccessToken);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...(init ?? {}), headers });
}
