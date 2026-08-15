import { PrivyClient } from "@privy-io/server-auth";
import { cookies, headers } from "next/headers";

let privy: PrivyClient | undefined;

function getPrivyClient() {
  if (privy) return privy;

  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Privy server credentials are not configured");
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

  if (!token) throw new Error("Unauthorized");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await getPrivyClient().verifyAuthToken(token);
      return { userId: result.userId };
    } catch {
      if (attempt === 1) throw new Error("Unauthorized");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  throw new Error("Unauthorized");
}
