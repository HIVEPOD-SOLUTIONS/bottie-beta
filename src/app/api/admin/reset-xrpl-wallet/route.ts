/**
 * ONE-TIME USE — DELETE AFTER USE
 * Clears the orphaned XRPL wallet record for the authenticated user so a
 * fresh wallet is created on next load.
 */
import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { neon } from "@neondatabase/serverless";

export async function POST() {
  try {
    const { userId } = await verifyAuth();

    const sql = neon(process.env.DATABASE_URL!);
    const result = await sql`
      DELETE FROM xrpl_sidebar_wallets
      WHERE user_id = ${userId}
      RETURNING wallet_request_id
    `;

    return NextResponse.json({
      success: true,
      deleted: result.length,
      walletRequestIds: result.map((r: { wallet_request_id: string }) => r.wallet_request_id),
    });
  } catch (err) {
    console.error("[reset-xrpl-wallet]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
