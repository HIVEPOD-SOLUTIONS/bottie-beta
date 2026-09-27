import { NextRequest, NextResponse } from "next/server";
import * as baseStocks from "@/lib/base-stocks";
import { verifyAuth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    await verifyAuth();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const { op, ...params } = body;

    let result: unknown;

    switch (op) {
      case "list":
        result = await baseStocks.listBaseStocks(params.query as string | undefined);
        break;
      case "get":
        result = await baseStocks.getBaseStock(params.symbolOrAddress as string);
        break;
      case "chains":
        result = await baseStocks.getBaseStocksChains();
        break;
      case "totalSupply":
        result = await baseStocks.getBaseStockTotalSupply(params.contractAddress as string);
        break;
      default:
        return NextResponse.json({ error: `Unknown op "${op}"` }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Failed" }, { status: 502 });
  }
}
