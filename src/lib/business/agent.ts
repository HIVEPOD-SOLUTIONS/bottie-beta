/**
 * The treasury agent. One run:
 *
 *   1. Reconciles payments still in flight (a broadcast tx whose receipt we
 *      hadn't seen yet).
 *   2. Reads what it has to work with: the treasury balance on Arc, what it
 *      already paid in the last 24h, and every open bill (the cash forecast).
 *   3. Runs the hard rules on each bill that is due soon: payee allowlisted,
 *      payee cap, per-payment cap, owner-approval threshold, daily cap, reserve
 *      and gas buffer, and a duplicate-invoice check.
 *   4. Asks the model to decide pay_now / defer / escalate for each, with a
 *      reason, given the whole picture (what's due when, what's left after).
 *   5. Enforces: a "pay" that breaks any rule is overruled and logged as
 *      blocked; bills over the approval threshold wait for the owner.
 *   6. Pays (atomically claimed, so a bill can never be paid twice), and logs
 *      every decision to the signed, hash-chained decision log.
 *
 * Without a model configured it falls back to the rules alone.
 */

import { and, eq, gt, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db } from "@/lib/db";
import { businessAccounts, businessBills, businessPayees, payments } from "@/lib/db/schema";
import { getLanguageModelCandidates } from "@/lib/ai/model-provider";
import { parsePolicy, type BusinessPolicy } from "@/lib/business/policy";
import { appendDecision } from "@/lib/business/ledger";
import { randomUUID } from "node:crypto";
import { GAS_BUFFER_USD, paymentStatus, sendTreasuryUsdc, treasuryBalance } from "@/lib/business/treasury";

type Business = typeof businessAccounts.$inferSelect;
type Bill = typeof businessBills.$inferSelect;
type Payee = typeof businessPayees.$inferSelect;

export type AgentAction = "pay_now" | "defer" | "escalate";

export interface RuleCheck { rule: string; ok: boolean; detail: string }

export interface RunResult {
  balanceUsd: number;
  spentLast24hUsd: number;
  considered: number;
  paid: { billId: string; payee: string; amountUsd: number; txHash: string }[];
  deferred: { billId: string; payee: string; reason: string }[];
  escalated: { billId: string; payee: string; reason: string }[];
  blocked: { billId: string; payee: string; reason: string }[];
  modelUsed: string | null;
}

const DAY = 86_400_000;
const money = (n: number) => `$${n.toFixed(2)}`;

/** Records a confirmed payment: bill -> paid, signed log entry, History row. Safe to call once per bill. */
async function recordPaid(business: Business, bill: Bill, payeeName: string, txHash: string | null, reason: string | null, inputs: Record<string, unknown>, log: (d: Parameters<typeof appendDecision>[1]) => Promise<unknown>) {
  const amount = Number(bill.amountUsdc);
  const [flipped] = await db.update(businessBills)
    .set({ status: "paid", paidTx: txHash, paidAt: new Date(), updatedAt: new Date() })
    .where(and(eq(businessBills.id, bill.id), eq(businessBills.status, "paying"))).returning({ id: businessBills.id });
  if (!flipped) return; // already recorded
  await log({ kind: "pay", actor: "agent", billId: bill.id, amountUsdc: amount, txHash, summary: `Paid ${payeeName} ${money(amount)} in USDC on Arc`, inputs, reasoning: reason });
  await db.insert(payments).values({
    userId: business.ownerUserId,
    type: "business",
    referenceId: bill.id,
    description: `${business.name}: paid ${payeeName} ${money(amount)}${bill.invoiceRef ? ` (invoice ${bill.invoiceRef})` : ""}`,
    amountUsdc: amount.toFixed(6),
    status: "completed",
    txHash,
    chain: "arc",
  }).catch(() => {});
}

/**
 * Bills already being paid when a previous run stopped mid-way, or whose
 * transfer Circle hadn't finished: settle them from Circle / the chain.
 */
async function reconcileInFlight(business: Business, payeeName: (id: string) => string) {
  const flying = await db.select().from(businessBills)
    .where(and(eq(businessBills.businessId, business.id), eq(businessBills.status, "paying")));
  const log = (d: Parameters<typeof appendDecision>[1]) => appendDecision(business, d);
  for (const b of flying) {
    if (!b.paidTx && !b.providerTxId) {
      // Claimed but nothing confirmed as sent (crash mid-way). Back to scheduled,
      // KEEPING payment_key: if the transfer did reach Circle, retrying with the
      // same key returns that same transfer instead of sending a second one.
      if (Date.now() - b.updatedAt.getTime() > 120_000) {
        await db.update(businessBills).set({ status: "scheduled", updatedAt: new Date() }).where(and(eq(businessBills.id, b.id), eq(businessBills.status, "paying")));
      }
      continue;
    }
    const st = await paymentStatus(business, { txHash: b.paidTx, providerTxId: b.providerTxId });
    if (st.state === "success") {
      await recordPaid(business, b, payeeName(b.payeeId), st.txHash ?? b.paidTx, b.decisionNote, { bill: { id: b.id }, settledLater: true, providerTxId: b.providerTxId }, log);
    } else if (st.state === "failed") {
      await db.update(businessBills).set({ status: "scheduled", paidTx: null, providerTxId: null, paymentKey: null, decisionNote: `failed[]: ${st.error ?? "payment failed"}`, updatedAt: new Date() }).where(eq(businessBills.id, b.id));
      await log({ kind: "failed", actor: "agent", billId: b.id, amountUsdc: Number(b.amountUsdc), summary: `Payment of ${money(Number(b.amountUsdc))} did not go through (${st.error ?? "failed"}); bill rescheduled`, inputs: { providerTxId: b.providerTxId, txHash: st.txHash } });
    }
  }
}

function checkBill(
  bill: Bill, payee: Payee | undefined, policy: BusinessPolicy,
  ctx: { available: number; spentToday: number; recentPaid: Bill[] },
): { checks: RuleCheck[]; needsApproval: boolean; suspicious: string | null } {
  const amount = Number(bill.amountUsdc);
  const checks: RuleCheck[] = [];
  checks.push({ rule: "payee_allowlisted", ok: !!payee?.allowlisted, detail: payee ? (payee.allowlisted ? `${payee.name} is on the allowlist` : `${payee.name} is not allowlisted`) : "payee missing" });
  if (payee?.capUsd != null) {
    checks.push({ rule: "payee_cap", ok: bill.ownerApproved || amount <= Number(payee.capUsd), detail: bill.ownerApproved ? "owner approved this amount" : `${money(amount)} vs ${payee.name}'s cap ${money(Number(payee.capUsd))}` });
  }
  checks.push({ rule: "per_payment_cap", ok: bill.ownerApproved || amount <= policy.perPaymentCapUsd, detail: bill.ownerApproved ? "owner approved this amount" : `${money(amount)} vs per-payment cap ${money(policy.perPaymentCapUsd)}` });
  checks.push({ rule: "daily_cap", ok: ctx.spentToday + amount <= policy.dailyCapUsd, detail: `${money(ctx.spentToday)} paid in 24h + ${money(amount)} vs daily cap ${money(policy.dailyCapUsd)}` });
  checks.push({ rule: "funds_after_reserve", ok: ctx.available >= amount, detail: `${money(ctx.available)} spendable (after ${money(policy.reserveUsd)} reserve and gas) vs ${money(amount)}` });

  const needsApproval = !bill.ownerApproved && (amount > policy.approvalAboveUsd || !policy.autopay);
  // Same payee, same amount, paid in the last 30 days under a different (or no) invoice ref → likely a duplicate.
  const dup = ctx.recentPaid.find((p) => p.payeeId === bill.payeeId && Number(p.amountUsdc) === amount && p.id !== bill.id && (p.invoiceRef ?? "") !== (bill.invoiceRef ?? "x"));
  const suspicious = dup ? `same payee and amount were paid on ${dup.paidAt?.toISOString().slice(0, 10)} (${dup.invoiceRef ?? "no invoice ref"})` : null;
  if (suspicious && !bill.ownerApproved) checks.push({ rule: "duplicate_check", ok: false, detail: `possible duplicate: ${suspicious}` });
  return { checks, needsApproval, suspicious };
}

const decisionSchema = z.object({
  decisions: z.array(z.object({
    billId: z.string(),
    action: z.enum(["pay_now", "defer", "escalate"]),
    reason: z.string().max(300),
  })),
});

async function askModel(context: unknown): Promise<{ decisions: { billId: string; action: AgentAction; reason: string }[]; model: string } | null> {
  let candidates;
  try { candidates = getLanguageModelCandidates(); } catch { return null; }
  const system =
    "You are the treasury agent for a small business. You decide, for each bill that is due soon, whether to pay it now, defer it, or escalate it to the owner. " +
    "Hard rules have already been checked and are given to you per bill; a bill with any failed rule must not be paid now (escalate it if the owner must act, defer it if time or funds will fix it). " +
    "Use judgement within the rules: pay what is due soonest first; don't pay early if that would leave too little for a bill due before more money is expected; " +
    "a contractor whose work is due is a higher priority than a renewable subscription; escalate anything unusual (possible duplicate, odd amount for that payee, missing invoice reference on a large bill). " +
    "Give a short, specific reason a reviewer can check against the numbers. Decide for every bill in `candidates`, by billId.";
  for (const c of candidates) {
    try {
      const { object } = await generateObject({
        model: c.model,
        schema: decisionSchema,
        system,
        prompt: JSON.stringify(context),
        maxRetries: 1,
      });
      return { decisions: object.decisions, model: c.name };
    } catch (err) {
      console.warn(`[business-agent] ${c.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

/** Rules-only decision, used when no model is available. */
function ruleDecision(checks: RuleCheck[], needsApproval: boolean): { action: AgentAction; reason: string } {
  const failed = checks.filter((c) => !c.ok);
  if (needsApproval) return { action: "escalate", reason: "Over the approval threshold — needs the owner's approval." };
  if (failed.some((c) => c.rule === "payee_allowlisted" || c.rule === "duplicate_check" || c.rule === "payee_cap" || c.rule === "per_payment_cap")) {
    return { action: "escalate", reason: failed.map((c) => c.detail).join("; ") };
  }
  if (failed.length) return { action: "defer", reason: failed.map((c) => c.detail).join("; ") };
  return { action: "pay_now", reason: "Due soon and every rule passes." };
}

export async function runTreasuryAgent(businessId: string, trigger: "owner" | "chat" | "schedule"): Promise<RunResult> {
  const [business] = await db.select().from(businessAccounts).where(eq(businessAccounts.id, businessId)).limit(1);
  if (!business) throw new Error("Business not found.");
  const policy = parsePolicy(business.policy);
  const payeeRows = await db.select().from(businessPayees).where(eq(businessPayees.businessId, businessId));
  await reconcileInFlight(business, (id) => payeeRows.find((p) => p.id === id)?.name ?? "payee");

  const [balance, openBills, recentPaid] = await Promise.all([
    treasuryBalance(business.treasuryAddress),
    db.select().from(businessBills).where(and(eq(businessBills.businessId, businessId), eq(businessBills.status, "scheduled"))),
    db.select().from(businessBills).where(and(eq(businessBills.businessId, businessId), eq(businessBills.status, "paid"), gt(businessBills.paidAt, new Date(Date.now() - 30 * DAY)))),
  ]);
  const payees = new Map(payeeRows.map((p) => [p.id, p]));
  const spentLast24h = recentPaid.filter((b) => b.paidAt && b.paidAt.getTime() > Date.now() - DAY).reduce((s, b) => s + Number(b.amountUsdc), 0);

  const result: RunResult = { balanceUsd: balance, spentLast24hUsd: spentLast24h, considered: 0, paid: [], deferred: [], escalated: [], blocked: [], modelUsed: null };

  const horizon = Date.now() + policy.payWithinDays * DAY;
  const due = openBills.filter((b) => b.dueAt.getTime() <= horizon).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  if (!due.length) return result;
  result.considered = due.length;

  // Spendable now, then reduced bill by bill as the plan is made (soonest first).
  let available = Math.max(0, balance - policy.reserveUsd - GAS_BUFFER_USD);
  let spentToday = spentLast24h;
  const forecast = openBills
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    .map((b) => ({ billId: b.id, payee: payees.get(b.payeeId)?.name ?? "?", kind: payees.get(b.payeeId)?.kind ?? "vendor", amountUsd: Number(b.amountUsdc), dueAt: b.dueAt.toISOString().slice(0, 10) }));

  const evaluated = due.map((bill) => {
    const payee = payees.get(bill.payeeId);
    const ev = checkBill(bill, payee, policy, { available, spentToday, recentPaid });
    // Plan as if the earlier bills will be paid, so the model sees what's really left.
    if (ev.checks.every((c) => c.ok) && !ev.needsApproval) {
      available -= Number(bill.amountUsdc);
      spentToday += Number(bill.amountUsdc);
    }
    return { bill, payee, ...ev };
  });

  const context = {
    today: new Date().toISOString().slice(0, 10),
    treasury: { balanceUsd: balance, reserveUsd: policy.reserveUsd, gasBufferUsd: GAS_BUFFER_USD, paidLast24hUsd: spentLast24h },
    policy,
    forecast_all_open_bills: forecast,
    totalOpenUsd: forecast.reduce((s, f) => s + f.amountUsd, 0),
    candidates: evaluated.map((e) => ({
      billId: e.bill.id,
      payee: e.payee?.name ?? "unknown",
      payeeKind: e.payee?.kind ?? "vendor",
      amountUsd: Number(e.bill.amountUsdc),
      dueAt: e.bill.dueAt.toISOString().slice(0, 10),
      invoiceRef: e.bill.invoiceRef,
      memo: e.bill.memo,
      ownerApproved: e.bill.ownerApproved,
      needsOwnerApproval: e.needsApproval,
      ruleChecks: e.checks,
    })),
  };

  const ai = await askModel(context);
  result.modelUsed = ai?.model ?? null;
  const byBill = new Map(ai?.decisions.map((d) => [d.billId, d]) ?? []);

  // The run itself is logged only when it leads to a new decision, so a
  // schedule that finds nothing new doesn't flood the log.
  let runLogged = false;
  const log = async (d: Parameters<typeof appendDecision>[1]) => {
    if (!runLogged) {
      runLogged = true;
      await appendDecision(business, {
        kind: "run",
        actor: "agent",
        summary: `Run (${trigger}): ${money(balance)} in treasury, ${due.length} bill(s) due within ${policy.payWithinDays} day(s), ${money(context.totalOpenUsd)} open in total`,
        inputs: { treasury: context.treasury, policy, forecast, model: result.modelUsed ?? "rules only" },
      });
    }
    return appendDecision(business, d);
  };

  let liveSpent = spentLast24h;
  let liveBalance = balance;

  for (const e of evaluated) {
    const { bill, payee } = e;
    const amount = Number(bill.amountUsdc);
    const name = payee?.name ?? "unknown payee";
    const fallback = ruleDecision(e.checks, e.needsApproval);
    const decided = byBill.get(bill.id) ?? fallback;
    const reason = decided.reason || fallback.reason;
    const failed = e.checks.filter((c) => !c.ok);
    const inputs = { bill: { id: bill.id, amountUsd: amount, dueAt: bill.dueAt.toISOString(), invoiceRef: bill.invoiceRef }, payee: payee ? { id: payee.id, name, address: payee.address } : null, ruleChecks: e.checks, modelDecision: byBill.get(bill.id) ?? null };
    // A decision is "new" when the action or the failing rules change — not when the
    // model merely words its reason differently — so repeated runs stay quiet.
    const ruleKey = failed.map((c) => c.rule).sort().join(",") + (e.needsApproval ? ",approval" : "");
    const note = (action: string, why: string) => `${action}[${ruleKey}]: ${why}`.slice(0, 500);
    const sameAsLast = (action: string) => (bill.decisionNote ?? "").startsWith(`${action}[${ruleKey}]:`);

    if (decided.action === "pay_now" && (failed.length || e.needsApproval)) {
      // The model wanted to pay, the rules say no: the rules win, and it's on the record.
      const why = e.needsApproval ? "needs the owner's approval first" : failed.map((c) => c.detail).join("; ");
      const nextStatus = e.needsApproval || failed.some((c) => c.rule !== "funds_after_reserve" && c.rule !== "daily_cap") ? "approval_needed" : "scheduled";
      if (!sameAsLast("blocked") || bill.status !== nextStatus) {
        await db.update(businessBills).set({ status: nextStatus, decisionNote: note("blocked", why), updatedAt: new Date() }).where(eq(businessBills.id, bill.id));
        await log({ kind: "blocked", actor: "agent", billId: bill.id, amountUsdc: amount, summary: `Blocked paying ${name} ${money(amount)} — ${why}`, inputs, reasoning: reason });
      }
      result.blocked.push({ billId: bill.id, payee: name, reason: why });
      continue;
    }

    if (decided.action === "escalate") {
      // Only something the owner must decide (approval, cap, allowlist, a possible
      // duplicate) holds the bill; a funds or daily-cap shortfall fixes itself, so
      // the bill stays scheduled and the alert is just on the record.
      const ownerMustAct = e.needsApproval || !!e.suspicious || failed.some((c) => c.rule !== "funds_after_reserve" && c.rule !== "daily_cap");
      if (!sameAsLast("escalate")) {
        await db.update(businessBills).set({ status: ownerMustAct ? "approval_needed" : "scheduled", decisionNote: note("escalate", reason), updatedAt: new Date() }).where(eq(businessBills.id, bill.id));
        await log({ kind: "escalate", actor: "agent", billId: bill.id, amountUsdc: amount, summary: ownerMustAct ? `Asked the owner about ${name} ${money(amount)}` : `Flagged ${name} ${money(amount)} to the owner (no action needed to keep it scheduled)`, inputs, reasoning: reason });
      }
      result.escalated.push({ billId: bill.id, payee: name, reason });
      continue;
    }

    if (decided.action === "defer") {
      // Logged once per distinct reason, so repeated runs don't flood the log.
      if (!sameAsLast("defer")) {
        await db.update(businessBills).set({ decisionNote: note("defer", reason), updatedAt: new Date() }).where(eq(businessBills.id, bill.id));
        await log({ kind: "defer", actor: "agent", billId: bill.id, amountUsdc: amount, summary: `Deferred ${name} ${money(amount)}`, inputs, reasoning: reason });
      }
      result.deferred.push({ billId: bill.id, payee: name, reason });
      continue;
    }

    // pay_now, and every rule passed. Re-check live numbers (earlier payments this run count).
    const spendable = liveBalance - policy.reserveUsd - GAS_BUFFER_USD;
    if (amount > spendable || liveSpent + amount > policy.dailyCapUsd) {
      const why = amount > spendable ? `only ${money(Math.max(0, spendable))} spendable now` : "daily cap reached this run";
      await log({ kind: "blocked", actor: "agent", billId: bill.id, amountUsdc: amount, summary: `Blocked paying ${name} ${money(amount)} — ${why}`, inputs, reasoning: reason });
      result.blocked.push({ billId: bill.id, payee: name, reason: why });
      continue;
    }

    // Claim the bill atomically: only one run can ever move it from scheduled to paying.
    const [claimed] = await db.update(businessBills).set({ status: "paying", updatedAt: new Date() })
      .where(and(eq(businessBills.id, bill.id), eq(businessBills.status, "scheduled"))).returning({ id: businessBills.id });
    if (!claimed) continue;

    try {
      // The idempotency key is saved BEFORE the transfer is requested, so any retry
      // (after a crash or a timeout) reuses it and Circle will not send twice.
      const paymentKey = bill.paymentKey ?? randomUUID();
      if (!bill.paymentKey) await db.update(businessBills).set({ paymentKey, decisionNote: note("paying", reason), updatedAt: new Date() }).where(eq(businessBills.id, bill.id));
      const out = await sendTreasuryUsdc(business, payee!.address, amount, paymentKey);
      await db.update(businessBills).set({ paidTx: out.txHash, providerTxId: out.providerTxId, updatedAt: new Date() }).where(eq(businessBills.id, bill.id));
      if (out.state === "failed") throw new Error(out.error ?? "payment failed");
      liveBalance -= amount;
      liveSpent += amount;
      if (out.state === "success") {
        await recordPaid(business, { ...bill, paymentKey }, name, out.txHash, reason, inputs, log);
        result.paid.push({ billId: bill.id, payee: name, amountUsd: amount, txHash: out.txHash ?? "" });
      } else {
        // Submitted, not confirmed yet: the next run (or the schedule) settles it.
        result.deferred.push({ billId: bill.id, payee: name, reason: "payment submitted, confirming on Arc" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A definite failure: clear the key so a later attempt is a new payment.
      await db.update(businessBills).set({ status: "scheduled", paidTx: null, providerTxId: null, paymentKey: null, decisionNote: note("failed", msg), updatedAt: new Date() })
        .where(and(eq(businessBills.id, bill.id), inArray(businessBills.status, ["paying"])));
      await log({ kind: "failed", actor: "agent", billId: bill.id, amountUsdc: amount, summary: `Payment to ${name} ${money(amount)} failed — will retry next run`, inputs: { ...inputs, error: msg.slice(0, 300) }, reasoning: reason });
      result.blocked.push({ billId: bill.id, payee: name, reason: `payment failed: ${msg.slice(0, 120)}` });
    }
  }

  await db.update(businessAccounts).set({ updatedAt: new Date() }).where(eq(businessAccounts.id, businessId));
  return result;
}
