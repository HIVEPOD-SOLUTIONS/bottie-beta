import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { isNetworkAdmin } from "@/lib/provider-network";

/**
 * GET /api/admin/me — whether the signed-in user is on the server's admin list. The app only uses this to decide whether to show
 * the Admin screen; every admin endpoint checks again on the server. Non-admins get a plain "false", never a 403, so it can't
 * be used to probe who is an admin.
 */
export async function GET() {
  try {
    const { userId } = await verifyAuth();
    return NextResponse.json({ admin: isNetworkAdmin(userId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return authErrorResponse(err);
  }
}
