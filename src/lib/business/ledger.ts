/**
 * The treasury's decision log — the continuous audit.
 *
 * Every action (by the agent or the owner) is appended as an entry whose hash
 * covers the previous entry's hash, and the hash is signed with the treasury's
 * own key. Anyone can recompute the chain and check each signature against the
 * treasury address (verifyDecisionLog), so the record can't be edited, reordered
 * or back-filled without it showing.
 */

import { createHash } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { verifyMessage, type Hex } from "viem";
import { db } from "@/lib/db";
import { businessDecisions } from "@/lib/db/schema";
import { signTreasuryMessage, type TreasuryRow } from "@/lib/business/treasury";

export type DecisionKind =
  | "created" | "payee_added" | "bill_added" | "run" | "pay" | "defer" | "escalate"
  | "blocked" | "approve" | "cancel" | "withdraw" | "policy" | "failed" | "public_log";

export interface DecisionInput {
  kind: DecisionKind;
  actor: "agent" | "owner";
  summary: string;
  inputs: Record<string, unknown>;
  reasoning?: string | null;
  billId?: string | null;
  amountUsdc?: number | null;
  txHash?: string | null;
}

type BusinessKeyRow = TreasuryRow;

const genesis = (businessId: string) => `genesis:${businessId}`;

/** The exact bytes that are hashed — stable key order, so anyone can recompute it. */
export function canonicalEntry(e: {
  businessId: string; seq: number; kind: string; actor: string; summary: string; inputs: string;
  reasoning: string | null; billId: string | null; amountUsdc: string | null; txHash: string | null;
  prevHash: string; createdAt: string;
}): string {
  return JSON.stringify([e.businessId, e.seq, e.kind, e.actor, e.summary, e.inputs, e.reasoning, e.billId, e.amountUsdc, e.txHash, e.prevHash, e.createdAt]);
}

const sha256 = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;

export async function appendDecision(business: BusinessKeyRow, d: DecisionInput): Promise<{ seq: number; hash: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [last] = await db.select({ seq: businessDecisions.seq, hash: businessDecisions.hash })
      .from(businessDecisions).where(eq(businessDecisions.businessId, business.id))
      .orderBy(desc(businessDecisions.seq)).limit(1);
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? genesis(business.id);
    const createdAt = new Date();
    const row = {
      businessId: business.id,
      seq,
      kind: d.kind,
      actor: d.actor,
      summary: d.summary.slice(0, 500),
      inputs: JSON.stringify(d.inputs ?? {}),
      reasoning: d.reasoning ? d.reasoning.slice(0, 2000) : null,
      billId: d.billId ?? null,
      amountUsdc: d.amountUsdc != null ? d.amountUsdc.toFixed(6) : null,
      txHash: d.txHash ?? null,
      prevHash,
    };
    const hash = sha256(canonicalEntry({ ...row, createdAt: createdAt.toISOString() }));
    // Signed by the treasury itself (through Circle for Circle wallets).
    const signature = await signTreasuryMessage(business, hash);
    try {
      await db.insert(businessDecisions).values({ ...row, hash, signature, createdAt });
      return { seq, hash };
    } catch (err) {
      // Another writer took this seq — re-read the tail and try again.
      const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
      if (cause?.code === "23505" || /duplicate key|unique/i.test(`${err instanceof Error ? err.message : err} ${cause?.message ?? ""}`)) continue;
      throw err;
    }
  }
  throw new Error("Couldn't append to the decision log (busy). Try again.");
}

export type DecisionRow = typeof businessDecisions.$inferSelect;

export async function listDecisions(businessId: string, limit = 100): Promise<DecisionRow[]> {
  return db.select().from(businessDecisions).where(eq(businessDecisions.businessId, businessId))
    .orderBy(desc(businessDecisions.seq)).limit(limit);
}

/**
 * Replays the whole log: every hash must match its contents and link to the
 * previous entry, and every signature must come from the treasury address.
 */
export async function verifyDecisionLog(businessId: string, treasuryAddress: string): Promise<{ ok: boolean; entries: number; brokenAt: number | null; reason: string | null }> {
  const rows = await db.select().from(businessDecisions).where(eq(businessDecisions.businessId, businessId)).orderBy(asc(businessDecisions.seq));
  let prev = genesis(businessId);
  for (const [i, r] of rows.entries()) {
    if (r.seq !== i + 1) return { ok: false, entries: rows.length, brokenAt: r.seq, reason: "gap in sequence" };
    if (r.prevHash !== prev) return { ok: false, entries: rows.length, brokenAt: r.seq, reason: "does not link to the previous entry" };
    const expect = sha256(canonicalEntry({
      businessId: r.businessId, seq: r.seq, kind: r.kind, actor: r.actor, summary: r.summary, inputs: r.inputs,
      reasoning: r.reasoning, billId: r.billId, amountUsdc: r.amountUsdc, txHash: r.txHash, prevHash: r.prevHash,
      createdAt: r.createdAt.toISOString(),
    }));
    if (expect !== r.hash) return { ok: false, entries: rows.length, brokenAt: r.seq, reason: "contents do not match the hash" };
    const signed = await verifyMessage({ address: treasuryAddress as Hex, message: r.hash, signature: r.signature as Hex }).catch(() => false);
    if (!signed) return { ok: false, entries: rows.length, brokenAt: r.seq, reason: "signature is not from the treasury" };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, brokenAt: null, reason: null };
}
