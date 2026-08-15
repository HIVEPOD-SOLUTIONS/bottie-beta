import { PrivyClient } from "@privy-io/server-auth";
import { cookies, headers } from "next/headers";

let privy: PrivyClient | undefined;

type AuthErrorCode = "missing_token" | "auth_not_configured" | "invalid_token";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly status = code === "auth_not_configured" ? 503 : 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function getPrivyClient() {
  if (privy) return privy;

  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new AuthError("auth_not_configured", "Privy server credentials are not configured");
  }

  privy = new PrivyClient(appId, appSecret);
  return privy;
}

export async function verifyAuth(): Promise<{ userId: string }> {
  // 1. Try Authorization: Bearer header first (explicit token from client)
  let token: string | undefined;
  try {
    const headerStore = await headers();
    const auth = headerStore.get("authorization") ?? headerStore.get("Authorization");
    if (auth?.startsWith("Bearer ")) token = auth.slice(7);
  } catch {
    // headers() may not be available in all contexts
  }

  // 2. Fall back to Privy session cookies
  if (!token) {
    const cookieStore = await cookies();
    token =
      cookieStore.get("privy-token")?.value ||
      cookieStore.get("privy-id-token")?.value;
  }

  if (!token) throw new AuthError("missing_token", "Missing authentication token");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await getPrivyClient().verifyAuthToken(token);
      return { userId: result.userId };
    } catch (err) {
      if (err instanceof AuthError && err.code === "auth_not_configured") throw err;
      if (attempt === 1) throw new AuthError("invalid_token", "Invalid authentication token");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  throw new AuthError("invalid_token", "Invalid authentication token");
}
