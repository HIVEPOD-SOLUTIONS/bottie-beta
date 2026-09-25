/**
 * Nosana API client — decentralized GPU cloud on Solana.
 *
 * Users deploy containerized AI workloads onto a network of GPU hosts.
 * Billing is credit-based (no on-chain signing from Bluvfi's side).
 *
 * Deployment lifecycle:
 *   1. POST /deployments → creates in DRAFT state
 *   2. POST /deployments/:id/start → STARTING → RUNNING (endpoint becomes live)
 *   3. POST /deployments/:id/stop → STOPPING → STOPPED (restartable)
 *   4. POST /deployments/:id/archive → ARCHIVED (permanent, non-restartable)
 *
 * Required env vars:
 *   NOSANA_API_BASE  — default https://dashboard.k8s.prd.nos.ci/api
 *   NOSANA_API_KEY   — Bearer token (nos_xxx_...)
 */

export const NOSANA_BASE = (
  process.env.NOSANA_API_BASE ?? "https://dashboard.k8s.prd.nos.ci/api"
).replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────────

export type DeploymentStatus =
  | "DRAFT"
  | "STARTING"
  | "RUNNING"
  | "STOPPING"
  | "STOPPED"
  | "ARCHIVED"
  | "ERROR"
  | "INSUFFICIENT_FUNDS";

export type DeploymentStrategy = "SIMPLE" | "SIMPLE-EXTEND" | "SCHEDULED" | "INFINITE";

export type MarketType = "PREMIUM" | "COMMUNITY" | "OTHER";

/** A GPU market as the rest of the app sees it (normalized from Nosana's raw shape below). */
export interface Market {
  address: string;
  slug: string;
  name: string;
  /** GPU model — the market name without a trailing "Community" tag. */
  gpu: string;
  /** VRAM in GB, or null when the market doesn't publish it. */
  vram: number | null;
  /** What a job costs on this market, in NOS per hour (job price per second × 3600). */
  price_nos_per_hour: number;
  type: MarketType;
}

/**
 * What GET /markets actually returns. There is no gpu, vram or price_per_hour_usd
 * field — code that read those crashed on undefined. VRAM lives in the metadata
 * list, and the client-side price is nos_job_price_per_second (NOS, not USD;
 * usd_reward_per_hour is what node operators earn, not what a job costs).
 */
interface RawMarket {
  address: string;
  slug?: string;
  name: string;
  type?: string;
  nos_job_price_per_second?: number;
  metadata?: { key: string; value: string }[];
}

export function normalizeMarket(r: RawMarket): Market {
  const vramRaw = r.metadata?.find((m) => m.key.toLowerCase() === "vram")?.value;
  const vram = vramRaw ? parseFloat(vramRaw) : NaN;
  const type: MarketType = r.type === "PREMIUM" || r.type === "COMMUNITY" ? r.type : "OTHER";
  return {
    address: r.address,
    slug: r.slug ?? "",
    name: r.name,
    gpu: r.name.replace(/\s+community$/i, "").trim(),
    vram: Number.isFinite(vram) ? vram : null,
    price_nos_per_hour: (r.nos_job_price_per_second ?? 0) * 3600,
    type,
  };
}

export interface JobDefinitionOp {
  type: "container/run" | "container/create-volume";
  id: string;
  args: {
    image?: string;
    cmd?: string | string[];
    gpu?: boolean;
    expose?: number;
    env?: Record<string, string>;
    work_dir?: string;
  };
}

export interface JobDefinition {
  version: string;
  type: "container";
  meta?: {
    trigger?: string;
    system?: { gpu?: { vram?: number } };
  };
  ops: JobDefinitionOp[];
}

export interface Deployment {
  id: string;
  name: string;
  status: DeploymentStatus;
  strategy: DeploymentStrategy;
  market: string;
  replicas: number;
  timeout: number;
  job_definition?: JobDefinition;
  /** First public URL of the deployment (derived from `endpoints`), if it has one. */
  endpoint?: string;
  /** What the API actually returns: one entry per exposed port. */
  endpoints?: { opId: string; port: number | string; url: string; online: boolean }[];
  created_at: string;
  updated_at: string;
  price_per_hour_usd?: number;
}

export interface Credits {
  assignedCredits: number;
  reservedCredits: number;
  settledCredits: number;
}

export interface SpendingTransaction {
  date: string;
  amount: number;
  deployment_id?: string;
  description?: string;
}

// ── Core fetch ─────────────────────────────────────────────────────────────────

function getApiKey() {
  const k = process.env.NOSANA_API_KEY;
  if (!k) throw new Error("NOSANA_API_KEY not configured");
  return k;
}

async function nosanaFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${NOSANA_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let parsed: { message?: string; error?: string } = {};
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    throw new Error(
      parsed.message ?? parsed.error ?? `NOSANA ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`,
    );
  }
  try { return JSON.parse(text) as T; } catch {
    throw new Error(`NOSANA: non-JSON response: ${text.slice(0, 200)}`);
  }
}

// ── Deployments ───────────────────────────────────────────────────────────────

/**
 * The API returns `endpoints[]` (one entry per exposed port) — there is no single
 * `endpoint` field, so the dashboard and the AI never saw a URL. Prefer one that is
 * online right now, else the first.
 */
export function normalizeDeployment(d: Deployment): Deployment {
  const list = Array.isArray(d.endpoints) ? d.endpoints : [];
  const best = list.find((e) => e.online && e.url) ?? list.find((e) => e.url);
  return best ? { ...d, endpoint: best.url } : d;
}

export async function listDeployments(): Promise<{ deployments: Deployment[] }> {
  const res = await nosanaFetch<{ deployments: Deployment[] }>("/deployments");
  return { ...res, deployments: (res.deployments ?? []).map(normalizeDeployment) };
}

export async function getDeployment(id: string): Promise<Deployment> {
  return normalizeDeployment(await nosanaFetch<Deployment>(`/deployments/${id}`));
}

export async function createDeployment(params: {
  name: string;
  market: string;
  timeout: number;
  replicas: number;
  strategy: DeploymentStrategy;
  job_definition: JobDefinition;
}): Promise<Deployment> {
  // Creation is POST /deployments/create — POST /deployments is a 404 (that path is
  // GET-only, for listing). Without autostart the deployment is left as a DRAFT,
  // so callers start it explicitly afterwards.
  return normalizeDeployment(
    await nosanaFetch<Deployment>("/deployments/create", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  );
}

export async function startDeployment(id: string): Promise<Deployment> {
  return normalizeDeployment(await nosanaFetch<Deployment>(`/deployments/${id}/start`, { method: "POST" }));
}

export async function stopDeployment(id: string): Promise<Deployment> {
  return normalizeDeployment(await nosanaFetch<Deployment>(`/deployments/${id}/stop`, { method: "POST" }));
}

export async function archiveDeployment(id: string): Promise<Deployment> {
  return normalizeDeployment(await nosanaFetch<Deployment>(`/deployments/${id}/archive`, { method: "POST" }));
}

// ── Markets ───────────────────────────────────────────────────────────────────

export async function listMarkets(): Promise<Market[]> {
  const raw = await nosanaFetch<RawMarket[]>("/markets");
  return Array.isArray(raw) ? raw.map(normalizeMarket) : [];
}

// ── Credits ───────────────────────────────────────────────────────────────────

export async function getCredits(): Promise<Credits> {
  // The balance lives at /credits/balance; bare /credits returns 404 NOT_FOUND.
  return nosanaFetch<Credits>("/credits/balance");
}

/**
 * What GET /credits/spending-history returns: one row per day (or month), each with
 * the total spent and a per-market breakdown. Amounts are in USD (`total_usd`).
 */
interface RawSpendingResponse {
  results?: {
    period: string;
    total_usd: number;
    breakdown?: { market: string; totalSpent: number }[];
  }[];
}

/**
 * Credit spending, newest first. `from` is REQUIRED by the API (start_date), so it
 * defaults to 90 days ago; `to` is optional. Grouped by day. `limit` trims to the
 * most recent N periods on our side — the endpoint has no limit parameter.
 *
 * Deliberately NOT /credits/transactions: that endpoint lists top-ups and purchases
 * (amountUsd, method), not what deployments consumed — see getCreditTransactions.
 */
export async function getSpendingHistory(params: {
  from?: string;
  to?: string;
  limit?: number;
} = {}): Promise<{ transactions: SpendingTransaction[] }> {
  const from = params.from ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const qs = new URLSearchParams({ start_date: from, group_by: "day" });
  if (params.to) qs.set("end_date", params.to);
  const raw = await nosanaFetch<RawSpendingResponse>(`/credits/spending-history?${qs}`);
  const rows = (raw.results ?? [])
    .map((r): SpendingTransaction => ({
      date: r.period,
      amount: r.total_usd,
      description: (r.breakdown ?? []).length
        ? (r.breakdown ?? []).map((b) => `${b.market.slice(0, 6)}… $${b.totalSpent.toFixed(4)}`).join(", ")
        : undefined,
    }))
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return { transactions: params.limit ? rows.slice(0, params.limit) : rows };
}

/** A top-up or purchase of credits (NOT spending) — from GET /credits/transactions. */
export interface CreditTransaction {
  id: string;
  type: string;
  amountUsd: number;
  createdAt: string;
  method: string | null;
}

export async function getCreditTransactions(params: { limit?: number; offset?: number } = {}): Promise<{
  transactions: CreditTransaction[];
  total: number;
}> {
  // limit and offset are both required by the API.
  const qs = new URLSearchParams({ limit: String(params.limit ?? 50), offset: String(params.offset ?? 0) });
  return nosanaFetch<{ transactions: CreditTransaction[]; total: number }>(`/credits/transactions?${qs}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a simple inference job definition from user-friendly params */
export function buildJobDefinition(params: {
  image: string;
  command?: string;
  expose_port?: number;
  env?: Record<string, string>;
}): JobDefinition {
  return {
    version: "0.1",
    type: "container",
    meta: { trigger: "api" },
    ops: [
      {
        type: "container/run",
        id: "main",
        args: {
          image: params.image,
          ...(params.command ? { cmd: params.command } : {}),
          gpu: true,
          ...(params.expose_port ? { expose: params.expose_port } : {}),
          ...(params.env ? { env: params.env } : {}),
        },
      },
    ],
  };
}
