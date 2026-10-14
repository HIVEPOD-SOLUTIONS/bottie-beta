import { NextResponse } from "next/server";
import { hashInboxKey, isInboxKey, readInbox } from "@/lib/inbox";
import { checkApiLimit } from "@/lib/user-rate-limiter";

/**
 * GET /api/notifications/inbox?after=<cursor> — what is new for this phone's owner, oldest first, with the new cursor.
 * Authorised by the phone's inbox key (Authorization: Bearer bvi_...), NOT a sign-in, because Android runs this in the background when the
 * app isn't open and there is no signed-in session then. The key reads notification text (a title, a short line, a screen to open) and
 * nothing else, only a hash of it is stored, and it is revoked when alerts are turned off.
 */
export async function GET(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!isInboxKey(key)) return NextResponse.json({ error: "Invalid key." }, { status: 401 });
  // Limited per key, so a leaked or looping phone can't hammer the database. A phone checks a few times an hour.
  const limit = await checkApiLimit(hashInboxKey(key).slice(0, 24), "inbox-read", 12, 600);
  if (!limit.allowed) return NextResponse.json({ error: limit.reason }, { status: 429, headers: limit.headers });
  try {
    const read = await readInbox(key, new URL(req.url).searchParams.get("after"));
    if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status });
    return NextResponse.json({ items: read.items, cursor: read.cursor }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[notifications/inbox]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't read your alerts right now." }, { status: 500 });
  }
}
