import { NextResponse } from "next/server";
import { StocksError } from "@/lib/stocks";
import { BackpackError, backpackConfigured } from "@/lib/backpack";

/** Maps stocks/Backpack errors to a safe JSON response for the /api/stocks routes. */
export function stocksErrorResponse(err: unknown, tag: string) {
  if (err instanceof StocksError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(`[stocks/${tag}]`, err instanceof Error ? err.message : err);
  if (err instanceof BackpackError && err.code === "NOT_CONFIGURED") {
    return NextResponse.json({ error: "Stock trading isn't set up on this server yet." }, { status: 501 });
  }
  return NextResponse.json({ error: "Stocks are temporarily unavailable. Please try again." }, { status: 502 });
}

/** 501 when the Backpack account keys aren't set, so the UI can show "coming soon". */
export function requireTrading() {
  return backpackConfigured()
    ? null
    : NextResponse.json({ error: "Stock trading isn't set up on this server yet." }, { status: 501 });
}
