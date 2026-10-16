/**
 * Bluvfi for Business — everything the routes and AI tools call: create a
 * business, manage payees and bills (including reading an invoice from pasted
 * text), owner approvals, policy, withdrawals, and the dashboard snapshot.
 * Every change an owner makes is written to the signed decision log too.
 */

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db } from "@/lib/db";
import { businessAccounts, businessBills, businessDecisions, businessPayees } from "@/lib/db/schema";
import { getUserEmbeddedEvmAddress } from "@/lib/auth";
import { getLanguageModelCandidates } from "@/lib/ai/model-provider";
import { DEFAULT_POLICY, parsePolicy, sanitizePolicy, type BusinessPolicy } from "@/lib/business/policy";
import { appendDecision, listDecisions } from "@/lib/business/ledger";
import { randomUUID } from "node:crypto";
import { GAS_BUFFER_USD, newTreasury, sendTreasuryUsdc, treasuryBalance } from "@/lib/business/treasury";

export type Business = typeof businessAccounts.$inferSelect;
export class BusinessError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const EVM = /^0x[0-9a-fA-F]{40}$/;
const money = (n: number) => `$${n.toFixed(2)}`;

export async function listBusinesses(userId: string) {
  return db.select({ id: businessAccounts.id, name: businessAccounts.name, treasuryAddress: businessAccounts.treasuryAddress, createdAt: businessAccounts.createdAt })
    .from(businessAccounts).where(eq(businessAccounts.ownerUserId, userId)).orderBy(asc(businessAccounts.createdAt));
}

export async function getOwnedBusiness(userId: string, businessId: string): Promise<Business> {
  const [b] = await db.select().from(businessAccounts)
    .where(and(eq(businessAccounts.id, businessId), eq(businessAccounts.ownerUserId, userId))).limit(1);
  if (!b) throw new BusinessError("Business not found.", 404);
  return b;
}

/** The user's only business, or the one named; for chat, where ids are awkward. */
export async function resolveBusiness(userId: string, businessId?: string): Promise<Business> {
  if (businessId) return getOwnedBusiness(userId, businessId);
  const [b] = await db.select().from(businessAccounts).where(eq(businessAccounts.ownerUserId, userId)).orderBy(asc(businessAccounts.createdAt)).limit(1);
  if (!b) throw new BusinessError("No business yet — create one first (Business tab, or ask me to set one up).", 404);
  return b;
}

export async function createBusiness(userId: string, name: string, policyIn?: Partial<BusinessPolicy>): Promise<Business> {
  const clean = name.trim().slice(0, 80);
  if (clean.length < 2) throw new BusinessError("Give the business a name.");
  const existing = await db.select({ id: businessAccounts.id }).from(businessAccounts).where(eq(businessAccounts.ownerUserId, userId));
  if (existing.length >= 5) throw new BusinessError("You can have up to 5 businesses.");
  const t = await newTreasury(clean);
  const policy = sanitizePolicy(policyIn ?? {}, DEFAULT_POLICY);
  const [b] = await db.insert(businessAccounts).values({
    id: t.id, ownerUserId: userId, name: clean, treasuryAddress: t.address, encryptedKey: t.encryptedKey,
    custody: t.custody, circleWalletId: t.circleWalletId, policy: JSON.stringify(policy),
  }).returning();
  await appendDecision(b, {
    kind: "created", actor: "owner",
    summary: `Business "${clean}" created with treasury ${t.address} on Arc (${t.custody === "circle" ? "Circle developer-controlled wallet" : "Bluvfi-held key"})`,
    inputs: { policy, custody: t.custody, circleWalletId: t.circleWalletId },
  });
  return b;
}

export async function updatePolicy(userId: string, businessId: string, patch: Partial<BusinessPolicy>): Promise<BusinessPolicy> {
  const b = await getOwnedBusiness(userId, businessId);
  const before = parsePolicy(b.policy);
  const after = sanitizePolicy(patch, before);
  await db.update(businessAccounts).set({ policy: JSON.stringify(after), updatedAt: new Date() }).where(eq(businessAccounts.id, b.id));
  await appendDecision(b, { kind: "policy", actor: "owner", summary: "Owner changed the treasury policy", inputs: { before, after } });
  return after;
}

export async function setPublicLog(userId: string, businessId: string, on: boolean): Promise<void> {
  const b = await getOwnedBusiness(userId, businessId);
  if (b.publicLog === on) return;
  await db.update(businessAccounts).set({ publicLog: on, updatedAt: new Date() }).where(eq(businessAccounts.id, b.id));
  await appendDecision(b, { kind: "public_log", actor: "owner", summary: on ? "Decision log made public" : "Decision log made private", inputs: { publicLog: on } });
}

export async function addPayee(userId: string, businessId: string, p: { name: string; address: string; kind?: string; capUsd?: number | null; notes?: string }) {
  const b = await getOwnedBusiness(userId, businessId);
  const name = p.name.trim().slice(0, 80);
  if (!name) throw new BusinessError("Payee name is required.");
  if (!EVM.test(p.address.trim())) throw new BusinessError("Payee address must be an 0x address (they're paid USDC on Arc).");
  if (p.address.trim().toLowerCase() === b.treasuryAddress.toLowerCase()) throw new BusinessError("That's the treasury itself.");
  const kind = p.kind === "contractor" ? "contractor" : "vendor";
  const cap = p.capUsd != null && Number(p.capUsd) > 0 ? Number(p.capUsd) : null;
  const [row] = await db.insert(businessPayees).values({
    businessId: b.id, name, kind, address: p.address.trim(), capUsd: cap != null ? cap.toFixed(6) : null, notes: p.notes?.slice(0, 300) ?? null,
  }).returning();
  await appendDecision(b, { kind: "payee_added", actor: "owner", summary: `Added ${kind} ${name} (${row.address})${cap ? ` with a ${money(cap)} cap` : ""}`, inputs: { payeeId: row.id, name, address: row.address, kind, capUsd: cap } });
  return row;
}

export async function setPayeeAllowlisted(userId: string, businessId: string, payeeId: string, allowlisted: boolean) {
  const b = await getOwnedBusiness(userId, businessId);
  const [row] = await db.update(businessPayees).set({ allowlisted }).where(and(eq(businessPayees.id, payeeId), eq(businessPayees.businessId, b.id))).returning();
  if (!row) throw new BusinessError("Payee not found.", 404);
  await appendDecision(b, { kind: "policy", actor: "owner", summary: `${allowlisted ? "Allowlisted" : "Removed from allowlist"}: ${row.name}`, inputs: { payeeId, allowlisted } });
  return row;
}

export async function addBill(userId: string, businessId: string, input: { payeeId: string; amountUsd: number; dueAt: string | Date; memo?: string; invoiceRef?: string; source?: string }) {
  const b = await getOwnedBusiness(userId, businessId);
  const [payee] = await db.select().from(businessPayees).where(and(eq(businessPayees.id, input.payeeId), eq(businessPayees.businessId, b.id))).limit(1);
  if (!payee) throw new BusinessError("Payee not found — add the vendor or contractor first.", 404);
  const amount = Number(input.amountUsd);
  if (!(amount > 0) || amount > 1_000_000) throw new BusinessError("Enter an amount above $0.");
  const due = new Date(input.dueAt);
  if (Number.isNaN(due.getTime())) throw new BusinessError("Enter a valid due date.");
  const invoiceRef = input.invoiceRef?.trim().slice(0, 80) || null;
  try {
    const [row] = await db.insert(businessBills).values({
      businessId: b.id, payeeId: payee.id, amountUsdc: amount.toFixed(6), dueAt: due, memo: input.memo?.slice(0, 300) ?? null, invoiceRef, source: input.source ?? "manual",
    }).returning();
    await appendDecision(b, { kind: "bill_added", actor: "owner", billId: row.id, amountUsdc: amount, summary: `Bill from ${payee.name}: ${money(amount)} due ${due.toISOString().slice(0, 10)}${invoiceRef ? ` (invoice ${invoiceRef})` : ""}`, inputs: { billId: row.id, payeeId: payee.id, source: row.source, memo: row.memo } });
    return row;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    if (cause?.code === "23505" || /duplicate key|unique/i.test(`${err instanceof Error ? err.message : err} ${cause?.message ?? ""}`)) {
      throw new BusinessError(`Invoice ${invoiceRef} from ${payee.name} is already on file — it won't be paid twice.`, 409);
    }
    throw err;
  }
}

const invoiceSchema = z.object({
  payeeName: z.string().describe("Who issued the invoice (the vendor or contractor to be paid)"),
  payeeAddress: z.string().nullable().describe("An 0x wallet address in the invoice for payment, if any"),
  amountUsd: z.number().describe("Total due, in US dollars"),
  dueDate: z.string().describe("Due date as YYYY-MM-DD; if none, 7 days after the invoice date"),
  invoiceNumber: z.string().nullable(),
  memo: z.string().nullable().describe("One line on what the invoice is for"),
});

/**
 * Reads an invoice from pasted text and files it as a bill. Only pays known
 * payees: if the issuer isn't one yet, returns what was read so the owner can
 * add them (an invoice can't add a new place for money to go by itself).
 */
export async function addBillFromInvoiceText(userId: string, businessId: string, text: string) {
  const b = await getOwnedBusiness(userId, businessId);
  if (text.trim().length < 20) throw new BusinessError("Paste the invoice text (at least a few lines).");
  let parsed: z.infer<typeof invoiceSchema> | null = null;
  let candidates;
  try { candidates = getLanguageModelCandidates(); } catch { throw new BusinessError("Invoice reading needs an AI provider configured.", 501); }
  for (const c of candidates) {
    try {
      const { object } = await generateObject({
        model: c.model, schema: invoiceSchema, maxRetries: 1,
        system: `Extract the fields from this invoice. Today is ${new Date().toISOString().slice(0, 10)}. Never invent an address.`,
        prompt: text.slice(0, 8000),
      });
      parsed = object;
      break;
    } catch (err) {
      console.warn(`[business] invoice extraction via ${c.name} failed:`, err instanceof Error ? err.message : err);
    }
  }
  if (!parsed) throw new BusinessError("Couldn't read that invoice. Add the bill by hand instead.", 502);

  const payees = await db.select().from(businessPayees).where(eq(businessPayees.businessId, b.id));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byAddress = parsed.payeeAddress && EVM.test(parsed.payeeAddress) ? payees.find((p) => p.address.toLowerCase() === parsed!.payeeAddress!.toLowerCase()) : undefined;
  const byName = payees.find((p) => norm(p.name) && (norm(parsed!.payeeName).includes(norm(p.name)) || norm(p.name).includes(norm(parsed!.payeeName))));
  const payee = byAddress ?? byName;
  // An invoice whose pay-to address differs from the payee on file is a classic fraud pattern.
  if (payee && parsed.payeeAddress && EVM.test(parsed.payeeAddress) && parsed.payeeAddress.toLowerCase() !== payee.address.toLowerCase()) {
    await appendDecision(b, { kind: "escalate", actor: "agent", summary: `Invoice from "${parsed.payeeName}" asks to be paid to ${parsed.payeeAddress}, not ${payee.name}'s address on file — not filed`, inputs: { parsed, payeeOnFile: { id: payee.id, address: payee.address } } });
    return { filed: false as const, parsed, reason: `The invoice's payment address (${parsed.payeeAddress}) differs from ${payee.name}'s address on file. Not filed — confirm with ${payee.name} directly.` };
  }
  if (!payee) {
    return { filed: false as const, parsed, reason: `"${parsed.payeeName}" isn't a payee yet. Add them first${parsed.payeeAddress ? ` (the invoice gives ${parsed.payeeAddress})` : ""}, then file the invoice again.` };
  }
  const bill = await addBill(userId, b.id, {
    payeeId: payee.id, amountUsd: parsed.amountUsd, dueAt: parsed.dueDate, memo: parsed.memo ?? undefined, invoiceRef: parsed.invoiceNumber ?? undefined, source: "invoice_text",
  });
  return { filed: true as const, parsed, bill, payee: { id: payee.id, name: payee.name } };
}

export async function approveBill(userId: string, businessId: string, billId: string) {
  const b = await getOwnedBusiness(userId, businessId);
  const [bill] = await db.update(businessBills).set({ ownerApproved: true, status: "scheduled", decisionNote: "approved by owner", updatedAt: new Date() })
    .where(and(eq(businessBills.id, billId), eq(businessBills.businessId, b.id), inArray(businessBills.status, ["approval_needed", "scheduled"]))).returning();
  if (!bill) throw new BusinessError("That bill can't be approved (already paid or cancelled).", 409);
  await appendDecision(b, { kind: "approve", actor: "owner", billId, amountUsdc: Number(bill.amountUsdc), summary: `Owner approved ${money(Number(bill.amountUsdc))}`, inputs: { billId } });
  return bill;
}

export async function cancelBill(userId: string, businessId: string, billId: string) {
  const b = await getOwnedBusiness(userId, businessId);
  const [bill] = await db.update(businessBills).set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(businessBills.id, billId), eq(businessBills.businessId, b.id), inArray(businessBills.status, ["approval_needed", "scheduled"]))).returning();
  if (!bill) throw new BusinessError("That bill can't be cancelled (already paid, paying or cancelled).", 409);
  await appendDecision(b, { kind: "cancel", actor: "owner", billId, amountUsdc: Number(bill.amountUsdc), summary: `Owner cancelled a ${money(Number(bill.amountUsdc))} bill`, inputs: { billId } });
  return bill;
}

/** Owner takes money out of the treasury — always to their own Bluvfi wallet. */
export async function withdraw(userId: string, businessId: string, amountUsd: number) {
  const b = await getOwnedBusiness(userId, businessId);
  const to = await getUserEmbeddedEvmAddress(userId);
  if (!to) throw new BusinessError("No Bluvfi wallet found to withdraw to.");
  const balance = await treasuryBalance(b.treasuryAddress);
  const max = Math.max(0, balance - GAS_BUFFER_USD);
  if (!(amountUsd > 0) || amountUsd > max) throw new BusinessError(`You can withdraw up to ${money(max)}.`);
  const out = await sendTreasuryUsdc(b, to, amountUsd, randomUUID());
  if (out.state === "failed") throw new BusinessError(`The withdrawal did not go through: ${out.error ?? "failed"}`, 502);
  await appendDecision(b, {
    kind: "withdraw", actor: "owner", amountUsdc: amountUsd, txHash: out.txHash,
    summary: `Owner withdrew ${money(amountUsd)} to ${to}${out.state === "pending" ? " (confirming)" : ""}`,
    inputs: { to, balanceBefore: balance, providerTxId: out.providerTxId },
  });
  return { txHash: out.txHash, to, state: out.state };
}

export async function businessSnapshot(userId: string, businessId: string) {
  const b = await getOwnedBusiness(userId, businessId);
  const [balance, payees, bills, decisions, totals] = await Promise.all([
    treasuryBalance(b.treasuryAddress).catch(() => null),
    db.select().from(businessPayees).where(eq(businessPayees.businessId, b.id)).orderBy(asc(businessPayees.createdAt)),
    db.select().from(businessBills).where(and(eq(businessBills.businessId, b.id), ne(businessBills.status, "cancelled"))).orderBy(desc(businessBills.createdAt)).limit(100),
    listDecisions(b.id, 50),
    db.select({
      paidCount: sql<number>`count(*) filter (where ${businessBills.status} = 'paid')`,
      paidUsd: sql<string>`coalesce(sum(${businessBills.amountUsdc}) filter (where ${businessBills.status} = 'paid'), 0)`,
    }).from(businessBills).where(eq(businessBills.businessId, b.id)),
  ]);
  const payeeName = new Map(payees.map((p) => [p.id, p.name]));
  return {
    id: b.id,
    name: b.name,
    treasuryAddress: b.treasuryAddress,
    custody: b.custody,
    publicLog: b.publicLog,
    policy: parsePolicy(b.policy),
    balanceUsd: balance,
    stats: { paidCount: Number(totals[0]?.paidCount ?? 0), paidUsd: Number(totals[0]?.paidUsd ?? 0), payees: payees.length },
    payees: payees.map((p) => ({ id: p.id, name: p.name, kind: p.kind, address: p.address, capUsd: p.capUsd != null ? Number(p.capUsd) : null, allowlisted: p.allowlisted })),
    bills: bills.map((x) => ({
      id: x.id, payeeId: x.payeeId, payee: payeeName.get(x.payeeId) ?? "?", amountUsd: Number(x.amountUsdc), dueAt: x.dueAt, memo: x.memo,
      invoiceRef: x.invoiceRef, status: x.status, ownerApproved: x.ownerApproved, decisionNote: x.decisionNote, paidTx: x.paidTx, paidAt: x.paidAt, source: x.source,
    })),
    decisions: decisions.map(publicDecision),
  };
}

export function publicDecision(d: typeof businessDecisions.$inferSelect) {
  return {
    seq: d.seq, kind: d.kind, actor: d.actor, summary: d.summary, reasoning: d.reasoning,
    amountUsd: d.amountUsdc != null ? Number(d.amountUsdc) : null, txHash: d.txHash, billId: d.billId,
    inputs: (() => { try { return JSON.parse(d.inputs); } catch { return {}; } })(),
    hash: d.hash, prevHash: d.prevHash, signature: d.signature, createdAt: d.createdAt,
  };
}
