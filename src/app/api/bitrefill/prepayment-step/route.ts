import { NextRequest, NextResponse } from "next/server";
import { mcpSubmitPrepaymentStep } from "@/lib/bitrefill-mcp";
import { verifyAuth } from "@/lib/auth";

/**
 * POST /api/bitrefill/prepayment-step
 *
 * Submit one step of a bill-payment prepayment form chain.
 * MCP-only — the CLI has no equivalent command.
 *
 * Body: { product_id: string; step_number: number; form_data: Record<string, string> }
 * Response:
 *   - Intermediate step: { step: "N", next_form: PrepaymentField[] }
 *   - Final step: { step: "final", bill_payment_id: string }
 */
export async function POST(req: NextRequest) {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { product_id, step_number = 1, form_data = {} } = body ?? {};

    if (!product_id) {
      return NextResponse.json({ error: "product_id is required" }, { status: 400 });
    }

    const result = await mcpSubmitPrepaymentStep({ product_id, step_number, form_data });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Prepayment step failed";
    console.error("[/api/bitrefill/prepayment-step]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
