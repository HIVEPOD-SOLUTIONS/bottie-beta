import { NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { verifyAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bills } from "@/lib/db/schema";
import { BILL_PROVIDERS } from "@/lib/constants";

export async function GET(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get("category");

    let query = db
      .select()
      .from(bills)
      .where(eq(bills.userId, userId))
      .orderBy(desc(bills.createdAt));

    const userBills = await query;
    const filtered = category
      ? userBills.filter((b) => b.category === category)
      : userBills;

    return NextResponse.json({ bills: filtered });
  } catch {
    return NextResponse.json({ bills: [] });
  }
}

export async function POST(req: Request) {
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, category, amount, dueDate, payeeAddress, autopay } = body as {
    name?: string;
    category?: string;
    amount?: string;
    dueDate?: string;
    payeeAddress?: string;
    autopay?: boolean;
  };

  if (!name || !category || !amount) {
    return NextResponse.json(
      { error: "Missing required fields: name, category, amount" },
      { status: 400 }
    );
  }

  const validCategories = ["streaming", "cable", "internet", "utility", "investment"];
  if (!validCategories.includes(category)) {
    return NextResponse.json(
      { error: `Invalid category. Must be one of: ${validCategories.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    // Look up known provider for logo and payee address if not provided
    const providerKey = Object.keys(BILL_PROVIDERS).find((k) =>
      name.toLowerCase().includes(k) ||
      BILL_PROVIDERS[k].name.toLowerCase().includes(name.toLowerCase())
    );
    const provider = providerKey ? BILL_PROVIDERS[providerKey] : null;

    const [bill] = await db
      .insert(bills)
      .values({
        userId,
        name,
        category,
        amount,
        dueDate: dueDate ?? null,
        payeeAddress: payeeAddress ?? provider?.payeeAddress ?? null,
        autopay: autopay ?? false,
        status: "pending",
        logoUrl: provider?.logo ?? null,
      })
      .returning();

    return NextResponse.json({ bill }, { status: 201 });
  } catch (err) {
    console.error("[Bills] Insert error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
