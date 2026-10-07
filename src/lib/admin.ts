import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { PAYMENTS, microToDecimal, type PayoutKind } from "@/lib/payments-rules";
import { assessRisk } from "@/lib/abuse";
import type { RiskAssessment } from "@/lib/abuse-rules";
import { getRealChain, paidLast24h, type PayoutChain } from "@/lib/skr-payout";
import { listStuckX402 } from "@/lib/x402-edge";
import { describeConfig, getConfigs, getPublishers, getTerms } from "@/lib/provider-network";

/**
 * What the team sees and does: the review queue (listings to verify, payouts to click) and an audit trail of every action.
 * Admin-ness is decided on the server only (NETWORK_ADMIN_USER_IDS); nothing here trusts the client.
 */

const rowsOf = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));
const num = (v: unknown) => Number(v ?? 0) || 0;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** Records what an admin did. Never throws: a failed audit write must not undo or block the action itself. */
export async function audit(adminUserId: string, action: string, targetType: string, targetId: string, detail?: string): Promise<void> {
  try {
    await db.execute(sql`insert into admin_audit (admin_user_id, action, target_type, target_id, detail) values (${adminUserId}, ${action}, ${targetType}, ${targetId}, ${detail?.slice(0, 500) ?? null})`);
  } catch (err) {
    console.error("[admin] audit write failed:", err instanceof Error ? err.message : err);
  }
}

export async function recentAudit(limit = 20) {
  return rowsOf<{ id: string; admin_user_id: string; action: string; target_type: string; target_id: string; detail: string | null; created_at: string }>(
    await db.execute(sql`select * from admin_audit order by created_at desc limit ${limit}`),
  ).map((r) => ({ id: r.id, admin: r.admin_user_id, action: r.action, targetType: r.target_type, targetId: r.target_id, detail: r.detail, at: iso(r.created_at) }));
}

export interface QueuePayout {
  kind: PayoutKind;
  id: string;
  userId: string;
  wallet: string;
  status: "requested" | "sending" | "paid";
  /** Shar claims: the Shar and the SKR fixed for them. Commission: the USD amount (SKR is priced when you click Pay). */
  shar: number | null;
  skr: string | null;
  usd: string | null;
  tx: string | null;
  note: string | null;
  at: string | null;
  ageMinutes: number;
  /** Links to other accounts by phone or wallet. Only worked out for payouts still waiting. */
  risk: RiskAssessment | null;
}

const normalizeStatus = (s: string): QueuePayout["status"] => (s === "processing" || s === "sent" ? "sending" : s === "paid" ? "paid" : "requested");

export async function getQueue(chain?: PayoutChain | null) {
  const listings = rowsOf<Record<string, string | null>>(
    await db.execute(sql`
      select id, name, summary, category, endpoint_url, docs_url, price_usdc, payout_wallet, remix_of_id, owner_user_id, created_at, review_note
      from provider_listings where status = 'submitted' order by created_at asc limit 50`),
  ).map((l) => ({
    id: String(l.id),
    name: String(l.name),
    summary: String(l.summary),
    category: String(l.category),
    endpointUrl: String(l.endpoint_url),
    docsUrl: l.docs_url,
    priceUsdc: String(l.price_usdc),
    payoutWallet: String(l.payout_wallet),
    remixOfId: l.remix_of_id,
    ownerUserId: String(l.owner_user_id),
    at: iso(l.created_at),
    reviewNote: l.review_note,
  }));
  // Who is behind each one and the terms they agreed to. Missing for listings that predate the questions (or before 0012 is run).
  const publishers = await getPublishers(listings.map((l) => l.id));
  const configs = await getConfigs(listings.map((l) => l.id));
  const ownerTerms = await getTerms(listings.map((l) => l.id));
  const listingsWithPublisher = listings.map((l) => ({
    ...l,
    publisher: publishers.get(l.id) ?? null,
    // The owner's own terms for the people who use the provider (the team checks them against Bluvfi's rules).
    ownerTerms: ownerTerms.get(l.id) ?? null,
    // Their inputs, requirements, notes for the team and what kind of key is saved (never the key itself).
    config: describeConfig(configs.get(l.id)),
    // Set when the team has already asked the owner something and is waiting for the answer.
  }));

  const claimRows = rowsOf<Record<string, string | null>>(
    await db.execute(sql`
      select id, user_id, wallet, status, shar, skr_amount, tx_signature, note, created_at,
             (extract(epoch from (now() - created_at)) / 60)::int as age_min
      from shar_claims where status in ('requested', 'processing', 'sent') or (status = 'paid' and updated_at > now() - interval '3 days')
      order by created_at desc limit 60`),
  );
  const commissionRows = rowsOf<Record<string, string | null>>(
    await db.execute(sql`
      select id, user_id, wallet, status, usd_micro, skr_micro, tx_signature, note, created_at,
             (extract(epoch from (now() - created_at)) / 60)::int as age_min
      from commission_payouts where status in ('requested', 'processing', 'sent') or (status = 'paid' and updated_at > now() - interval '3 days')
      order by created_at desc limit 60`),
  );

  const payouts: QueuePayout[] = [
    ...claimRows.map((r): QueuePayout => ({
      kind: "shar_claim", id: String(r.id), userId: String(r.user_id), wallet: String(r.wallet), status: normalizeStatus(String(r.status)),
      shar: num(r.shar), skr: String(r.skr_amount), usd: null, tx: r.tx_signature, note: r.note, at: iso(r.created_at), ageMinutes: num(r.age_min), risk: null,
    })),
    ...commissionRows.map((r): QueuePayout => ({
      kind: "commission", id: String(r.id), userId: String(r.user_id), wallet: String(r.wallet), status: normalizeStatus(String(r.status)),
      shar: null, skr: r.skr_micro === null ? null : microToDecimal(num(r.skr_micro)), usd: microToDecimal(num(r.usd_micro)), tx: r.tx_signature, note: r.note, at: iso(r.created_at), ageMinutes: num(r.age_min), risk: null,
    })),
  ].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  // Who is linked to whom, for the payouts an admin still has to decide on. A failed check never hides the payout.
  await Promise.all(
    payouts.filter((p) => p.status === "requested").map(async (p) => {
      p.risk = await assessRisk(p.userId, p.wallet).catch(() => null);
    }),
  );

  let treasury: { address: string; skr: string; sol: string; configured: true } | { configured: false } = { configured: false };
  try {
    const c = chain ?? (await getRealChain());
    const bal = await c.balances();
    treasury = { configured: true, address: c.treasuryAddress(), skr: microToDecimal(bal.skrMicro), sol: (bal.lamports / 1e9).toFixed(4) };
  } catch {
    /* not configured, or the chain is unreachable: the queue still works */
  }

  // Agent payments whose settlement we never heard back about: an admin checks each one on-chain. Empty until 0009 is applied.
  let stuckX402: Awaited<ReturnType<typeof listStuckX402>> = [];
  try {
    stuckX402 = await listStuckX402();
  } catch {
    /* x402 isn't set up yet */
  }

  return {
    listings: listingsWithPublisher,
    stuckX402,
    payouts: {
      waiting: payouts.filter((p) => p.status === "requested"),
      sending: payouts.filter((p) => p.status === "sending"),
      paid: payouts.filter((p) => p.status === "paid").slice(-10).reverse(),
    },
    treasury,
    limits: {
      maxPayoutSkr: PAYMENTS.maxPayoutSkr,
      dailyCapSkr: PAYMENTS.dailyPayoutCapSkr,
      paidLast24hSkr: microToDecimal(await paidLast24h()),
      maxQuoteDriftPct: PAYMENTS.maxQuoteDriftBps / 100,
    },
  };
}
