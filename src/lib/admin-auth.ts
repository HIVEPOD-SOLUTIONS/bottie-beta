import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { isNetworkAdmin } from "@/lib/provider-network";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * The one gate every admin route goes through: signed in, on the server's admin list, and not hammering.
 * The list lives only in the server's environment (NETWORK_ADMIN_USER_IDS); the client is never asked who is an admin.
 */
export async function requireAdmin(): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return { ok: false, response: authErrorResponse(err) };
  }
  if (!isNetworkAdmin(userId)) return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  const limit = await checkApiLimit(userId, "admin", 60, 3000);
  if (!limit.allowed) return { ok: false, response: NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers }) };
  return { ok: true, userId };
}
