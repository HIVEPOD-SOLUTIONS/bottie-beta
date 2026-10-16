import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-response";
import {
  BusinessError, addBill, addBillFromInvoiceText, addPayee, approveBill, businessSnapshot, cancelBill,
  getOwnedBusiness, setPayeeAllowlisted, setPublicLog, updatePolicy, withdraw,
} from "@/lib/business/service";
import { runTreasuryAgent } from "@/lib/business/agent";
import { verifyDecisionLog } from "@/lib/business/ledger";

/** GET /api/business/{id} — dashboard snapshot (owner only). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const { id } = await params;
  try {
    return NextResponse.json(await businessSnapshot(userId, id));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/business/{id} { action, ... } — owner actions:
 * addPayee, setPayeeAllowlisted, addBill, addInvoice, approveBill, cancelBill,
 * updatePolicy, setPublicLog, run, withdraw, verify.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch (err) {
    return authErrorResponse(err);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    switch (body.action) {
      case "addPayee":
        return NextResponse.json({ payee: await addPayee(userId, id, { name: String(body.name ?? ""), address: String(body.address ?? ""), kind: String(body.kind ?? "vendor"), capUsd: body.capUsd == null || body.capUsd === "" ? null : Number(body.capUsd), notes: body.notes ? String(body.notes) : undefined }) });
      case "setPayeeAllowlisted":
        return NextResponse.json({ payee: await setPayeeAllowlisted(userId, id, String(body.payeeId), body.allowlisted === true) });
      case "addBill":
        return NextResponse.json({ bill: await addBill(userId, id, { payeeId: String(body.payeeId ?? ""), amountUsd: Number(body.amountUsd), dueAt: String(body.dueAt ?? ""), memo: body.memo ? String(body.memo) : undefined, invoiceRef: body.invoiceRef ? String(body.invoiceRef) : undefined }) });
      case "addInvoice":
        return NextResponse.json(await addBillFromInvoiceText(userId, id, String(body.text ?? "")));
      case "approveBill":
        return NextResponse.json({ bill: await approveBill(userId, id, String(body.billId)) });
      case "cancelBill":
        return NextResponse.json({ bill: await cancelBill(userId, id, String(body.billId)) });
      case "updatePolicy":
        return NextResponse.json({ policy: await updatePolicy(userId, id, (body.policy ?? {}) as Record<string, never>) });
      case "setPublicLog":
        await setPublicLog(userId, id, body.on === true);
        return NextResponse.json({ ok: true });
      case "run":
        await getOwnedBusiness(userId, id);
        return NextResponse.json(await runTreasuryAgent(id, "owner"));
      case "withdraw":
        return NextResponse.json(await withdraw(userId, id, Number(body.amountUsd)));
      case "verify": {
        const b = await getOwnedBusiness(userId, id);
        return NextResponse.json(await verifyDecisionLog(b.id, b.treasuryAddress));
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof BusinessError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error("[business]", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: err instanceof Error ? err.message : "Something went wrong" }, { status: 500 });
}
