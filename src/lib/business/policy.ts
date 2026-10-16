/**
 * Treasury policy: the limits the agent cannot talk its way past. They are
 * enforced in code (lib/business/agent.ts) after the model has decided, so a
 * model that says "pay" for a bill that breaks a rule is overruled and the
 * refusal is logged.
 */

export interface BusinessPolicy {
  /** Most the agent may pay out in any rolling 24 hours, in USD. */
  dailyCapUsd: number;
  /** Most for any single payment without the owner's approval. */
  perPaymentCapUsd: number;
  /** Payments above this need the owner's approval first. */
  approvalAboveUsd: number;
  /** Kept in the treasury at all times (never spent by the agent). */
  reserveUsd: number;
  /** Pay bills this many days before they are due (0 = on the due date). */
  payWithinDays: number;
  /** Off = the agent only recommends; every payment needs the owner. */
  autopay: boolean;
}

export const DEFAULT_POLICY: BusinessPolicy = {
  dailyCapUsd: 200,
  perPaymentCapUsd: 100,
  approvalAboveUsd: 50,
  reserveUsd: 1,
  payWithinDays: 2,
  autopay: true,
};

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

/** Accepts partial / untrusted input and returns a complete, bounded policy. */
export function sanitizePolicy(input: Partial<Record<keyof BusinessPolicy, unknown>> | null | undefined, base: BusinessPolicy = DEFAULT_POLICY): BusinessPolicy {
  const p = input ?? {};
  return {
    dailyCapUsd: clamp(p.dailyCapUsd, 0, 100_000, base.dailyCapUsd),
    perPaymentCapUsd: clamp(p.perPaymentCapUsd, 0, 100_000, base.perPaymentCapUsd),
    approvalAboveUsd: clamp(p.approvalAboveUsd, 0, 100_000, base.approvalAboveUsd),
    reserveUsd: clamp(p.reserveUsd, 0, 100_000, base.reserveUsd),
    payWithinDays: Math.round(clamp(p.payWithinDays, 0, 30, base.payWithinDays)),
    autopay: typeof p.autopay === "boolean" ? p.autopay : base.autopay,
  };
}

export function parsePolicy(json: string): BusinessPolicy {
  try {
    return sanitizePolicy(JSON.parse(json));
  } catch {
    return { ...DEFAULT_POLICY };
  }
}
