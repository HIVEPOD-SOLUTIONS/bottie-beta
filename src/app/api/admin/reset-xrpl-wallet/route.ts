/**
 * POST /api/admin/reset-xrpl-wallet
 *
 * ONE-TIME cleanup endpoint — deletes the orphaned xrpl_sidebar_wallets row
 * for the authenticated user so a fresh wallet is generated on next sidebar open.
 *
 * DELETE THIS FILE after use.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { xrplSidebarWallets } from "@/lib/db/schema";

export async function POST() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  const deleted = await db
    .delete(xrplSidebarWallets)
    .where(eq(xrplSidebarWallets.userId, userId))
    .returning();

  return NextResponse.json({
    ok: true,
    deleted: deleted.length,
    message: deleted.length
      ? `Cleared ${deleted.length} XRP wallet row(s). Refresh the app to generate a new wallet.`
      : "No XRP wallet row found for this user — nothing to clear.",
  });
}
