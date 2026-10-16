import { tool } from "ai";
import { z } from "zod";

/**
 * Bluvfi for Business from chat: set up a business treasury on Arc, add
 * payees and bills (or file an invoice from pasted text), run the treasury
 * agent, approve or cancel what it escalated, allow or block payees, change
 * its limits, and read (or publish) the signed decision log. Withdrawals stay
 * in the Business tab. The agent's limits are enforced server-side whatever is said
 * here; the chat can't raise them past what the owner sets.
 */
export function createBusinessTools(userId?: string) {
  const need = () => {
    if (!userId) throw new Error("Not authenticated");
    return userId;
  };
  const fail = (err: unknown) => ({ error: err instanceof Error ? err.message : "Something went wrong" });
  const svc = () => import("@/lib/business/service");

  return {
    business_overview: tool({
      description:
        "The user's business treasury (Bluvfi for Business): USDC balance on Arc, treasury address, policy limits, payees, open/approval-needed/paid bills and the latest agent decisions. " +
        "Call first for any question about their business money, bills, vendors or contractors.",
      inputSchema: z.object({ businessId: z.string().optional().describe("Only if they have several businesses") }),
      execute: async ({ businessId }) => {
        try {
          const { resolveBusiness, businessSnapshot, listBusinesses } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          const s = await businessSnapshot(uid, b.id);
          return {
            businesses: (await listBusinesses(uid)).map((x) => ({ id: x.id, name: x.name })),
            ...s,
            bills: s.bills.slice(0, 30),
            decisions: s.decisions.slice(0, 12).map((d) => ({ seq: d.seq, kind: d.kind, summary: d.summary, reasoning: d.reasoning, txHash: d.txHash, at: d.createdAt })),
            auditPage: s.publicLog ? `/audit/${s.id}` : null,
          };
        } catch (err) { return fail(err); }
      },
    }),

    business_create: tool({
      description: "Create a business with its own treasury wallet on Arc (USDC). Only when the user asks to set one up. Optional starting limits.",
      inputSchema: z.object({
        name: z.string().min(2).max(80),
        dailyCapUsd: z.number().positive().optional(),
        perPaymentCapUsd: z.number().positive().optional(),
        approvalAboveUsd: z.number().nonnegative().optional(),
      }),
      execute: async ({ name, ...policy }) => {
        try {
          const { createBusiness } = await svc();
          const b = await createBusiness(need(), name, policy);
          return {
            id: b.id, name: b.name, treasuryAddress: b.treasuryAddress, custody: b.custody,
            tip: `Treasury created (${b.custody === "circle" ? "a Circle developer-controlled wallet on Arc" : "a key Bluvfi holds encrypted, since Circle wallets aren't set up on this server"}). Tell them to fund it with USDC on Arc (Business tab → Fund, from their Bluvfi wallet), then add payees and bills.`,
          };
        } catch (err) { return fail(err); }
      },
    }),

    business_add_payee: tool({
      description: "Add a vendor or contractor the treasury may pay (USDC on Arc, to their 0x address). Confirm the name and address with the user first; never guess an address.",
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        kind: z.enum(["vendor", "contractor"]).optional(),
        capUsd: z.number().positive().optional().describe("Most any single bill to them may be without the owner's approval"),
        businessId: z.string().optional(),
      }),
      execute: async ({ businessId, ...p }) => {
        try {
          const { resolveBusiness, addPayee } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          const row = await addPayee(uid, b.id, p);
          return { payeeId: row.id, name: row.name, address: row.address, kind: row.kind };
        } catch (err) { return fail(err); }
      },
    }),

    business_add_bill: tool({
      description: "File a bill/invoice/contractor milestone for an existing payee. The agent decides when to pay it (within the limits). Duplicate invoice numbers are refused.",
      inputSchema: z.object({
        payee: z.string().describe("Payee name or id"),
        amountUsd: z.number().positive(),
        dueDate: z.string().describe("YYYY-MM-DD"),
        invoiceRef: z.string().max(80).optional(),
        memo: z.string().max(300).optional(),
        businessId: z.string().optional(),
      }),
      execute: async ({ payee, amountUsd, dueDate, invoiceRef, memo, businessId }) => {
        try {
          const { resolveBusiness, addBill, businessSnapshot } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          const s = await businessSnapshot(uid, b.id);
          const p = s.payees.find((x) => x.id === payee) ?? s.payees.find((x) => x.name.toLowerCase().includes(payee.toLowerCase()));
          if (!p) return { error: `No payee called "${payee}". Payees: ${s.payees.map((x) => x.name).join(", ") || "none yet"}.` };
          const bill = await addBill(uid, b.id, { payeeId: p.id, amountUsd, dueAt: `${dueDate}T12:00:00Z`, invoiceRef, memo, source: "chat" });
          return { billId: bill.id, payee: p.name, amountUsd, dueDate, tip: "Filed. Offer to run the agent now (business_run_agent) if it's due soon." };
        } catch (err) { return fail(err); }
      },
    }),

    business_file_invoice: tool({
      description: "Read an invoice the user pasted (text) and file it as a bill for a known payee. If the issuer isn't a payee, or the invoice's pay-to address differs from the one on file, it is NOT filed and the reason is returned.",
      inputSchema: z.object({ text: z.string().min(20).max(8000), businessId: z.string().optional() }),
      execute: async ({ text, businessId }) => {
        try {
          const { resolveBusiness, addBillFromInvoiceText } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          return await addBillFromInvoiceText(uid, b.id, text);
        } catch (err) { return fail(err); }
      },
    }),

    business_run_agent: tool({
      description:
        "Run the treasury agent now: it checks the treasury balance and every bill due soon, applies the owner's hard limits, decides pay / defer / escalate with a reason, " +
        "and PAYS what passes (real USDC on Arc). Call only when the user asks to run it or to pay what's due. Report each payment with its tx and each hold with its reason.",
      inputSchema: z.object({ businessId: z.string().optional() }),
      execute: async ({ businessId }) => {
        try {
          const { resolveBusiness } = await svc();
          const { runTreasuryAgent } = await import("@/lib/business/agent");
          const b = await resolveBusiness(need(), businessId);
          const r = await runTreasuryAgent(b.id, "chat");
          return { ...r, paid: r.paid.map((p) => ({ ...p, explorer: `https://explorer.arc.io/tx/${p.txHash}` })) };
        } catch (err) { return fail(err); }
      },
    }),

    business_approve_bill: tool({
      description: "Approve a bill the agent escalated (over the approval threshold, over a payee cap, or a possible duplicate). Only after the user explicitly approves that specific bill. The agent pays it on its next run.",
      inputSchema: z.object({ billId: z.string(), businessId: z.string().optional() }),
      execute: async ({ billId, businessId }) => {
        try {
          const { resolveBusiness, approveBill } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          const bill = await approveBill(uid, b.id, billId);
          return { approved: true, billId: bill.id, amountUsd: Number(bill.amountUsdc), tip: "Approved. Offer to run the agent now to pay it." };
        } catch (err) { return fail(err); }
      },
    }),

    business_cancel_bill: tool({
      description: "Cancel a bill that hasn't been paid yet (scheduled or waiting for approval), so the agent never pays it. Only after the user explicitly asks to cancel that specific bill. Paid or paying bills can't be cancelled.",
      inputSchema: z.object({ billId: z.string(), businessId: z.string().optional() }),
      execute: async ({ billId, businessId }) => {
        try {
          const { resolveBusiness, cancelBill } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          const bill = await cancelBill(uid, b.id, billId);
          return { cancelled: true, billId: bill.id, amountUsd: Number(bill.amountUsdc) };
        } catch (err) { return fail(err); }
      },
    }),

    business_set_payee_allowlisted: tool({
      description:
        "Allow or block a payee. The agent only pays allowlisted payees; a bill to a blocked payee is held even if approved. " +
        "Only when the user explicitly asks to allow or block that specific payee (confirm the name and address back).",
      inputSchema: z.object({
        payee: z.string().describe("Payee name or id"),
        allowlisted: z.boolean().describe("true = may be paid, false = blocked"),
        businessId: z.string().optional(),
      }),
      execute: async ({ payee, allowlisted, businessId }) => {
        try {
          const { resolveBusiness, setPayeeAllowlisted, businessSnapshot } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          const s = await businessSnapshot(uid, b.id);
          const p = s.payees.find((x) => x.id === payee) ?? s.payees.find((x) => x.name.toLowerCase().includes(payee.toLowerCase()));
          if (!p) return { error: `No payee called "${payee}". Payees: ${s.payees.map((x) => x.name).join(", ") || "none yet"}.` };
          const row = await setPayeeAllowlisted(uid, b.id, p.id, allowlisted);
          return { payeeId: row.id, name: row.name, address: row.address, allowlisted: row.allowlisted };
        } catch (err) { return fail(err); }
      },
    }),

    business_set_public_log: tool({
      description: "Make the treasury agent's signed decision log public (a shareable /audit page anyone can verify) or private again. Only when the user asks.",
      inputSchema: z.object({ public: z.boolean(), businessId: z.string().optional() }),
      execute: async ({ public: on, businessId }) => {
        try {
          const { resolveBusiness, setPublicLog } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          await setPublicLog(uid, b.id, on);
          return { publicLog: on, auditPage: on ? `/audit/${b.id}` : null };
        } catch (err) { return fail(err); }
      },
    }),

    business_set_policy: tool({
      description: "Change the treasury agent's limits. Only values the user explicitly asked to change. State the new limits back.",
      inputSchema: z.object({
        dailyCapUsd: z.number().nonnegative().optional(),
        perPaymentCapUsd: z.number().nonnegative().optional(),
        approvalAboveUsd: z.number().nonnegative().optional(),
        reserveUsd: z.number().nonnegative().optional(),
        payWithinDays: z.number().int().min(0).max(30).optional(),
        autopay: z.boolean().optional(),
        businessId: z.string().optional(),
      }),
      execute: async ({ businessId, ...patch }) => {
        try {
          const { resolveBusiness, updatePolicy } = await svc();
          const uid = need();
          const b = await resolveBusiness(uid, businessId);
          return { policy: await updatePolicy(uid, b.id, patch) };
        } catch (err) { return fail(err); }
      },
    }),

    business_decision_log: tool({
      description: "The treasury agent's signed decision log (what it saw, the rule it applied, why, what it paid), plus a live verification of the hash chain and signatures.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional(), businessId: z.string().optional() }),
      execute: async ({ limit, businessId }) => {
        try {
          const { resolveBusiness } = await svc();
          const { listDecisions, verifyDecisionLog } = await import("@/lib/business/ledger");
          const b = await resolveBusiness(need(), businessId);
          const [rows, verification] = await Promise.all([listDecisions(b.id, limit ?? 15), verifyDecisionLog(b.id, b.treasuryAddress)]);
          return {
            verification,
            publicPage: b.publicLog ? `/audit/${b.id}` : "private (they can make it public in the Business tab → Decision log)",
            entries: rows.map((d) => ({ seq: d.seq, kind: d.kind, actor: d.actor, summary: d.summary, reasoning: d.reasoning, txHash: d.txHash, at: d.createdAt })),
          };
        } catch (err) { return fail(err); }
      },
    }),
  };
}
