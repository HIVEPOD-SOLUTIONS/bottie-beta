import { NextResponse } from "next/server";
import { audit } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-auth";
import { isPayoutKind } from "@/lib/payments-rules";
import { PayoutError, payPayout, quotePayout, reconcilePayout, rejectPayout } from "@/lib/skr-payout";
import { isMissingTable } from "@/lib/shar";

export const maxDuration = 60; // a payout waits for the transaction to confirm

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ kind: string; id: string }> };

async function parse(ctx: Ctx) {
  const { kind, id } = await ctx.params;
  if (!isPayoutKind(kind) || !UUID.test(id)) return null;
  return { kind, id };
}

/** GET /api/admin/payouts/:kind/:id — what paying this would send: the SKR amount (priced now for commission) and the treasury's balances. */
export async function GET(_req: Request, ctx: Ctx) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;
  const target = await parse(ctx);
  if (!target) return NextResponse.json({ error: "Payout not found" }, { status: 404 });
  try {
    return NextResponse.json({ quote: await quotePayout(target.kind, target.id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof PayoutError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    if (isMissingTable(err)) return NextResponse.json({ error: "The payout tables aren't set up yet." }, { status: 503 });
    console.error("[admin/payout quote]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't price that payout." }, { status: 500 });
  }
}

/**
 * POST /api/admin/payouts/:kind/:id  { action: "pay" | "reject" | "reconcile", note?, expectedSkrMicro?, acknowledgeRisk? }
 *  • pay: sends the SKR. Commission needs the amount you reviewed (expectedSkrMicro); if the price has moved too far it refuses.
 *    If the account is linked to others by phone or wallet it refuses (409 risk_unacknowledged, with the flags) unless acknowledgeRisk is true.
 *  • reject: declines a waiting payout (Shar returns, or commission goes back to the owner).
 *  • reconcile: settles a stuck payout from what the chain says. Safe to press any number of times.
 * Every action is recorded in the audit trail with who did it.
 */
export async function POST(req: Request, ctx: Ctx) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;
  const target = await parse(ctx);
  if (!target) return NextResponse.json({ error: "Payout not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = body?.action;
  const note = typeof body?.note === "string" ? body.note : "";
  const label = `${target.kind}`;

  try {
    if (action === "pay") {
      const expected = typeof body.expectedSkrMicro === "number" && Number.isSafeInteger(body.expectedSkrMicro) ? body.expectedSkrMicro : undefined;
      await audit(gate.userId, "payout.pay.start", label, target.id, expected ? `expected ${expected} micro-SKR` : undefined);
      const res = await payPayout({ kind: target.kind, id: target.id, expectedSkrMicro: expected, acknowledgeRisk: body.acknowledgeRisk === true });
      await audit(gate.userId, res.ok ? `payout.pay.${res.status}` : `payout.pay.refused.${res.code}`, label, target.id, res.ok ? res.signature : res.error);
      if (res.ok && res.acknowledged.length > 0) await audit(gate.userId, "payout.risk.acknowledged", label, target.id, res.acknowledged.join(", "));
      if (!res.ok) return NextResponse.json({ error: res.error, code: res.code, quote: res.quote, risk: res.risk }, { status: res.status });
      return NextResponse.json({ status: res.status, signature: res.signature, skrMicro: res.skrMicro });
    }
    if (action === "reject") {
      const res = await rejectPayout(target.kind, target.id, note);
      await audit(gate.userId, res.ok ? "payout.reject" : "payout.reject.refused", label, target.id, note || undefined);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
      return NextResponse.json({ status: "rejected" });
    }
    if (action === "reconcile") {
      const res = await reconcilePayout(target.kind, target.id);
      await audit(gate.userId, `payout.reconcile.${res.ok ? res.outcome : "error"}`, label, target.id, res.ok ? res.message : res.error);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
      return NextResponse.json({ outcome: res.outcome, message: res.message });
    }
    return NextResponse.json({ error: "action must be pay, reject or reconcile" }, { status: 400 });
  } catch (err) {
    if (isMissingTable(err)) return NextResponse.json({ error: "The payout tables aren't set up yet." }, { status: 503 });
    console.error("[admin/payout]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Something went wrong. Check the payout's status before trying again." }, { status: 500 });
  }
}
