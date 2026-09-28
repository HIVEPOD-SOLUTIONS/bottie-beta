/**
 * Per-user ownership for Nosana deployments.
 *
 * Nosana's API has no concept of separate end-users — the whole app shares one
 * NOSANA_API_KEY / prepaid-credit account, so every deployment lives in that single account
 * with nothing distinguishing whose is whose at the API level. This module is what makes
 * Nosana user-centric on Bluvfi's side: it records who created each deployment, and every
 * caller (AI tools, API routes) filters/checks against it before showing or acting on one.
 *
 * Credits and spending history remain genuinely shared/org-wide — Nosana bills the one
 * account, not per-user, so there's nothing to scope there; only deployments are ownable.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nosanaDeployments } from "@/lib/db/schema";
import type { Deployment } from "@/lib/nosana";

export class NosanaDeploymentNotOwnedError extends Error {
  constructor() {
    super("No deployment with that id belongs to this user.");
    this.name = "NosanaDeploymentNotOwnedError";
  }
}

/** Call right after a deployment is created, so it has an owner from the start. */
export async function recordNosanaDeployment(userId: string, deploymentId: string) {
  await db
    .insert(nosanaDeployments)
    .values({ userId, deploymentId })
    .onConflictDoNothing({ target: nosanaDeployments.deploymentId });
}

/** All deployment ids this user has created, for filtering a full Nosana listDeployments() result. */
export async function listOwnedNosanaDeploymentIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ deploymentId: nosanaDeployments.deploymentId })
    .from(nosanaDeployments)
    .where(eq(nosanaDeployments.userId, userId));
  return new Set(rows.map((r) => r.deploymentId));
}

/** Filters a full Nosana deployment list down to just this user's own. */
export async function filterToOwnedDeployments(userId: string, deployments: Deployment[]): Promise<Deployment[]> {
  const owned = await listOwnedNosanaDeploymentIds(userId);
  return deployments.filter((d) => owned.has(d.id));
}

/** Throws NosanaDeploymentNotOwnedError unless this deployment belongs to this user. */
export async function assertOwnsNosanaDeployment(userId: string, deploymentId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(nosanaDeployments)
    .where(eq(nosanaDeployments.deploymentId, deploymentId))
    .limit(1);
  if (!row || row.userId !== userId) throw new NosanaDeploymentNotOwnedError();
}
