import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";

export function authErrorResponse(err: unknown) {
  if (err instanceof AuthError) {
    const error =
      err.code === "auth_not_configured"
        ? "Authentication service is not configured"
        : "Unauthorized";
    return NextResponse.json({ error, code: err.code }, { status: err.status });
  }

  return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
}
