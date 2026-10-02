/**
 * POST /api/balances   — upsert a balance snapshot (called by the client hook after every refresh).
 *   Body: { evmAddress?, solAddress?, evmUsdc, evmUsdt, solUsdc, solUsdt }
 *   Deduplication: skips insert if all four balances changed by less than $0.001 since the last snapshot.
 *
 * GET  /api/balances?limit=N  — return the last N snapshots for the user (default 100, max 500).
 *   Used by balance history charts and the AI agent's get_balance_history tool.
 */

import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { db } from "@/lib/db";
import { balanceSnapshots } from "@/lib/db/schema";

const CHANGE_THRESHOLD = 0.001; // minimum $0.001 change to trigger a new snapshot

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { evmAddress, solAddress, evmUsdc, evmUsdt, solUsdc, solUsdt } = body as {
    evmAddress?: string;
    solAddress?: string;
    evmUsdc?: number;
    evmUsdt?: number;
    solUsdc?: number;
    solUsdt?: number;
  };

  const eu = Number(evmUsdc ?? 0);
  const et = Number(evmUsdt ?? 0);
  const su = Number(solUsdc ?? 0);
  const st = Number(solUsdt ?? 0);
  const total = eu + et + su + st;

  try {
    // Deduplication — fetch last snapshot and skip if nothing materially changed
    const [last] = await db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.userId, userId))
      .orderBy(desc(balanceSnapshots.createdAt))
      .limit(1);

    if (last) {
      const delta =
        Math.abs(Number(last.evmUsdc) - eu) +
        Math.abs(Number(last.evmUsdt) - et) +
        Math.abs(Number(last.solUsdc) - su) +
        Math.abs(Number(last.solUsdt) - st);
      if (delta < CHANGE_THRESHOLD) {
        return NextResponse.json({ skipped: true });
      }
    }

    const [snapshot] = await db
      .insert(balanceSnapshots)
      .values({
        userId,
        evmAddress: evmAddress ?? null,
        solAddress: solAddress ?? null,
        evmUsdc: eu.toFixed(6),
        evmUsdt: et.toFixed(6),
        solUsdc: su.toFixed(6),
        solUsdt: st.toFixed(6),
        totalUsdc: total.toFixed(6),
      })
      .returning();

    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (err) {
    console.error("[balances] insert error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "100"), 500);

  try {
    const snapshots = await db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.userId, userId))
      .orderBy(desc(balanceSnapshots.createdAt))
      .limit(limit);

    return NextResponse.json({ snapshots });
  } catch {
    return NextResponse.json({ snapshots: [] });
  }
}
