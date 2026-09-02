import { eq } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { xrplSidebarWallets } from "@/lib/db/schema";
import { createWalletRequest, isXrplBackendConfigured } from "@/lib/xrplBackend";

/**
 * GET /api/xrpl/sidebar-wallet
 *
 * Returns the user's persistent XRPL wallet, creating it on first call.
 * createWalletRequest is idempotent on idempotencyKey server-side (bluvfi-xrpl),
 * so it's safe to call every time this route is hit — it only actually
 * creates a new wallet once per user. The local row is just a cache so the
 * sidebar doesn't need a round-trip to bluvfi-xrpl on every render.
 */
export async function GET() {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch (err) {
    return authErrorResponse(err);
  }

  if (!isXrplBackendConfigured()) {
    return Response.json({ error: "XRPL service not configured" }, { status: 501 });
  }

  try {
    // Local cache hit — skip the bluvfi-xrpl round-trip entirely.
    const [existing] = await db
      .select()
      .from(xrplSidebarWallets)
      .where(eq(xrplSidebarWallets.userId, userId))
      .limit(1);
    if (existing) {
      return Response.json({ id: existing.walletRequestId, address: existing.address });
    }

    const wallet = await createWalletRequest({
      privyDid: userId,
      idempotencyKey: "primary-xrp-wallet",
    });

    await db
      .insert(xrplSidebarWallets)
      .values({ userId, walletRequestId: wallet.id, address: wallet.address })
      .onConflictDoUpdate({
        target: xrplSidebarWallets.userId,
        set: { walletRequestId: wallet.id, address: wallet.address, updatedAt: new Date() },
      });

    return Response.json({ id: wallet.id, address: wallet.address });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load XRPL wallet";
    console.error("[xrpl/sidebar-wallet]", message);
    return Response.json({ error: message }, { status: 502 });
  }
}
