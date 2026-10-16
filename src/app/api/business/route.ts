import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import { BusinessError, createBusiness, listBusinesses } from "@/lib/business/service";

/** GET /api/business — the user's businesses. POST { name, policy? } — create one (with its Arc treasury). */
export async function GET() {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  return NextResponse.json({ businesses: await listBusinesses(userId) });
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const body = (await req.json().catch(() => ({}))) as { name?: string; policy?: Record<string, unknown> };
  try {
    const b = await createBusiness(userId, body.name ?? "", body.policy);
    return NextResponse.json({ id: b.id, name: b.name, treasuryAddress: b.treasuryAddress });
  } catch (err) {
    const status = err instanceof BusinessError ? err.status : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't create the business" }, { status });
  }
}
