/**
 * Roaster API client — AI rap battle platform on Solana.
 *
 * Battle lifecycle:
 *   1. Creator deposits 10 USDC creation bond → POST /v1/battles
 *   2. Rap creators pick a side + angles → POST /v1/battles/:id/raps (AI writes bars + produces track)
 *   3. Supporters back a side with USDC (parimutuel, time-weighted)
 *   4. At deadline, AI Jury (Claude + GPT + Gemini) scores both songs on craft dimensions
 *   5. Winner earns losing pool proportionally; IP Revenue NFTs minted to rap creators
 *
 * Fee structure (per backing):
 *   Total 1.25%: 0.25% creator / 0.60% rap creators / 0.30% protocol / 0.10% referral
 *
 * Required env vars:
 *   ROASTER_API_BASE  — e.g. https://api.roaster.gg
 *   ROASTER_API_KEY   — API key (obtained via Roaster developer dashboard)
 */

export const ROASTER_BASE = (process.env.ROASTER_API_BASE ?? "https://api.roaster.gg").replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────────

export type DurationTier = "15m" | "6h" | "24h";
export type BattleStatus = "open" | "live" | "judging" | "settled" | "voided";

export interface BattleSide {
  name: string;
  pool_usdc: number;
  rap_id?: string;
  track_url?: string;
  creator_address?: string;
}

export interface Battle {
  battle_id: string;
  topic: string;
  sides: [BattleSide, BattleSide];
  status: BattleStatus;
  duration_tier: DurationTier;
  starts_at: string;
  ends_at: string;
  creator_address: string;
  creation_bond_usdc: number;
  total_pool_usdc: number;
  winner_side?: 0 | 1;
  jury_transcript_url?: string;
  jury_irys_tx_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Rap {
  rap_id: string;
  battle_id: string;
  side: 0 | 1;
  creator_address: string;
  angles: string[];
  bars?: string;
  track_url?: string;
  status: "generating" | "ready" | "failed";
  created_at: string;
}

export interface Backing {
  backing_id: string;
  battle_id: string;
  side: 0 | 1;
  backer_address: string;
  amount_usdc: number;
  time_weight: number;
  potential_payout_usdc?: number;
  created_at: string;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  username?: string;
  wins: number;
  losses: number;
  total_backed_usdc: number;
  total_earned_usdc: number;
  battles_created: number;
  raps_created: number;
}

export interface BattleWallet {
  address: string;
  balance_usdc: number;
  pending_payouts_usdc: number;
}

// ── Core fetch ─────────────────────────────────────────────────────────────────

function getApiKey() {
  const k = process.env.ROASTER_API_KEY;
  if (!k) throw new Error("ROASTER_API_KEY not configured");
  return k;
}

async function roasterFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ROASTER_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getApiKey(),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: { message?: string; error?: string } = {};
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    throw new Error(parsed.message ?? parsed.error ?? `ROASTER ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  try { return JSON.parse(text) as T; } catch {
    throw new Error(`ROASTER: non-JSON response: ${text.slice(0, 200)}`);
  }
}

// ── Battles ───────────────────────────────────────────────────────────────────

export async function listBattles(params: {
  status?: BattleStatus;
  limit?: number;
  offset?: number;
  creator_address?: string;
} = {}): Promise<{ battles: Battle[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  if (params.creator_address) qs.set("creator_address", params.creator_address);
  const q = qs.toString();
  return roasterFetch<{ battles: Battle[]; total: number }>(`/v1/battles${q ? `?${q}` : ""}`);
}

export async function getBattle(battleId: string): Promise<Battle> {
  return roasterFetch<Battle>(`/v1/battles/${battleId}`);
}

/**
 * Create a new battle. Returns a Solana transaction the creator must sign
 * to transfer the 10 USDC creation bond to the battle vault.
 */
export async function createBattle(params: {
  topic: string;
  side_a_name: string;
  side_b_name: string;
  duration_tier: DurationTier;
  creator_address: string;
}): Promise<{ battle_id: string; bond_transaction: string }> {
  return roasterFetch<{ battle_id: string; bond_transaction: string }>("/v1/battles", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// ── Raps ──────────────────────────────────────────────────────────────────────

/**
 * Submit angles for a side — AI writes bars and produces the full track.
 * The first creator to finish a side locks it (one song per side).
 */
export async function createRap(params: {
  battle_id: string;
  side: 0 | 1;
  angles: string[];
  creator_address: string;
}): Promise<Rap> {
  return roasterFetch<Rap>(`/v1/battles/${params.battle_id}/raps`, {
    method: "POST",
    body: JSON.stringify({
      side: params.side,
      angles: params.angles,
      creator_address: params.creator_address,
    }),
  });
}

export async function getRap(rapId: string): Promise<Rap> {
  return roasterFetch<Rap>(`/v1/raps/${rapId}`);
}

// ── Backing ───────────────────────────────────────────────────────────────────

/**
 * Back a side with USDC. Returns a Solana transaction the backer must sign.
 * Fee is 1.25% of amount (split: 0.25% creator / 0.60% rap creators / 0.30% protocol / 0.10% referral).
 * Earlier backing earns more — the pool is time-weighted.
 */
export async function backSide(params: {
  battle_id: string;
  side: 0 | 1;
  amount_usdc: number;
  backer_address: string;
  referrer_address?: string;
}): Promise<{ backing_id: string; transaction: string; platform_fee_usdc: number; time_weight: number }> {
  return roasterFetch<{ backing_id: string; transaction: string; platform_fee_usdc: number; time_weight: number }>(
    `/v1/battles/${params.battle_id}/back`,
    {
      method: "POST",
      body: JSON.stringify({
        side: params.side,
        amount_usdc: params.amount_usdc,
        backer_address: params.backer_address,
        ...(params.referrer_address ? { referrer_address: params.referrer_address } : {}),
      }),
    },
  );
}

export async function getMyBackings(params: {
  backer_address: string;
  battle_id?: string;
  limit?: number;
}): Promise<{ backings: Backing[] }> {
  const qs = new URLSearchParams({ backer_address: params.backer_address });
  if (params.battle_id) qs.set("battle_id", params.battle_id);
  if (params.limit) qs.set("limit", String(params.limit));
  return roasterFetch<{ backings: Backing[] }>(`/v1/backings?${qs}`);
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

export async function getLeaderboard(params: {
  limit?: number;
  offset?: number;
  metric?: "earnings" | "wins" | "battles_created";
} = {}): Promise<{ entries: LeaderboardEntry[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  if (params.metric) qs.set("metric", params.metric);
  const q = qs.toString();
  return roasterFetch<{ entries: LeaderboardEntry[]; total: number }>(`/v1/leaderboard${q ? `?${q}` : ""}`);
}

// ── Wallet ────────────────────────────────────────────────────────────────────

export async function getBattleWallet(walletAddress: string): Promise<BattleWallet> {
  return roasterFetch<BattleWallet>(`/v1/wallet/${walletAddress}`);
}
