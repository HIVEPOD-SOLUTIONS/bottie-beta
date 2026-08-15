"use client";

type GetAccessToken = () => Promise<string | null>;

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  getAccessToken: GetAccessToken,
) {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...(init ?? {}), headers });
}
