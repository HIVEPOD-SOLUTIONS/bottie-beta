import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts } from "@/lib/db/schema";
import { listDecisions, verifyDecisionLog } from "@/lib/business/ledger";
import { publicDecision } from "@/lib/business/service";

/**
 * GET /api/business/{id}/log — the signed decision log, readable by anyone
 * once the owner makes it public (for auditors, partners, hackathon judges).
 * Includes a live verification of the whole hash chain and every signature.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [b] = await db.select().from(businessAccounts).where(eq(businessAccounts.id, id)).limit(1);
  if (!b || !b.publicLog) return NextResponse.json({ error: "This decision log isn't public." }, { status: 404 });
  const [entries, verification] = await Promise.all([listDecisions(b.id, 500), verifyDecisionLog(b.id, b.treasuryAddress)]);
  return NextResponse.json({
    business: { name: b.name, treasuryAddress: b.treasuryAddress },
    verification,
    howToVerify: "hash = sha256(JSON.stringify([businessId, seq, kind, actor, summary, inputs, reasoning, billId, amountUsdc, txHash, prevHash, createdAtISO])); each prevHash is the previous entry's hash (the first is 'genesis:<businessId>'); signature is an EIP-191 personal_sign of the hash by the treasury address.",
    entries: entries.map((d) => ({ ...publicDecision(d), businessId: d.businessId, amountUsdcRaw: d.amountUsdc, inputsRaw: d.inputs })),
  }, { headers: { "Cache-Control": "public, max-age=15" } });
}
