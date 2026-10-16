import { NextRequest, NextResponse } from "next/server";
import { and, eq, lte } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { businessBills } from "@/lib/db/schema";
import { runTreasuryAgent } from "@/lib/business/agent";
import { getServerEnv } from "@/lib/server-env";

/**
 * POST /api/business/cron — runs the treasury agent for every business with a
 * bill due within the next 30 days. Called hourly by the GitHub Actions
 * workflow .github/workflows/business-cron.yml (or any scheduler) with the
 * header `x-cron-secret: <BUSINESS_CRON_SECRET>`. Each run respects the business's
 * own policy and is fully logged, exactly like a run the owner starts.
 */
export async function POST(req: NextRequest) {
  const secret = getServerEnv("BUSINESS_CRON_SECRET");
  const given = req.headers.get("x-cron-secret") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const soon = new Date(Date.now() + 30 * 86_400_000);
  const rows = await db.selectDistinct({ businessId: businessBills.businessId }).from(businessBills)
    .where(and(eq(businessBills.status, "scheduled"), lte(businessBills.dueAt, soon)));
  const results = [];
  for (const r of rows.slice(0, 25)) {
    try {
      const out = await runTreasuryAgent(r.businessId, "schedule");
      results.push({ businessId: r.businessId, paid: out.paid.length, escalated: out.escalated.length, deferred: out.deferred.length, blocked: out.blocked.length });
    } catch (err) {
      results.push({ businessId: r.businessId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ ran: results.length, results });
}
