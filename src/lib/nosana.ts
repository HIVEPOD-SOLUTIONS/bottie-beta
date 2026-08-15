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

export type MarketType = "PREMIUM" | "COMMUNITY";

export interface Market {
  address: string;
  name: string;
  gpu: string;
  vram: number;
  price_per_hour_usd: number;
  type: MarketType;
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
  endpoint?: string;
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

export async function listDeployments(): Promise<{ deployments: Deployment[] }> {
  return nosanaFetch<{ deployments: Deployment[] }>("/deployments");
}

export async function getDeployment(id: string): Promise<Deployment> {
  return nosanaFetch<Deployment>(`/deployments/${id}`);
}

export async function createDeployment(params: {
  name: string;
  market: string;
  timeout: number;
  replicas: number;
  strategy: DeploymentStrategy;
  job_definition: JobDefinition;
}): Promise<Deployment> {
  return nosanaFetch<Deployment>("/deployments", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function startDeployment(id: string): Promise<Deployment> {
  return nosanaFetch<Deployment>(`/deployments/${id}/start`, { method: "POST" });
}

export async function stopDeployment(id: string): Promise<Deployment> {
  return nosanaFetch<Deployment>(`/deployments/${id}/stop`, { method: "POST" });
}

export async function archiveDeployment(id: string): Promise<Deployment> {
  return nosanaFetch<Deployment>(`/deployments/${id}/archive`, { method: "POST" });
}

// ── Markets ───────────────────────────────────────────────────────────────────

export async function listMarkets(): Promise<Market[]> {
  return nosanaFetch<Market[]>("/markets");
}

// ── Credits ───────────────────────────────────────────────────────────────────

export async function getCredits(): Promise<Credits> {
  return nosanaFetch<Credits>("/credits");
}

export async function getSpendingHistory(params: {
  from?: string;
  to?: string;
  limit?: number;
} = {}): Promise<{ transactions: SpendingTransaction[] }> {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return nosanaFetch<{ transactions: SpendingTransaction[] }>(`/credits/spending${q ? `?${q}` : ""}`);
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
