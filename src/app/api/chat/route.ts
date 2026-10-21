import { convertToModelMessages, streamText, stepCountIs, type UIMessage } from "ai";
import { getLanguageModelCandidates } from "@/lib/ai/model-provider";
import { createTools } from "@/lib/ai/tools";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { windowMessages, extractConversationRecap, conversationTopics } from "@/lib/ai/window-messages";
import { verifyAuth } from "@/lib/auth";
import { checkChatLimit, checkChatTokenBudget, checkToolBudget, recordChatTokens, refundChat } from "@/lib/user-rate-limiter";
import { isUserPremium } from "@/lib/revenuecat-server";
import { db } from "@/lib/db";
import { xrplSidebarWallets } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getWalletRequest } from "@/lib/xrplBackend";
import { resolveXrpBalance } from "@/lib/xrplBalance";

// Allow streaming responses up to 60s on Vercel Pro/Enterprise.
// Hobby plan is capped at 10s — upgrade if you hit timeouts on long AI steps.
export const maxDuration = 60;

/** A chat request is a few KB; refuse anything absurd before parsing it (and again after windowing). */
const MAX_BODY_BYTES = 1_000_000;
const MAX_CONTEXT_CHARS = 300_000;

/**
 * The agent's tools call paid third parties, and one chat request can run up to ten steps. Wrap every executable
 * tool so each run is counted against the user's daily tool budget (checkToolBudget); over it, the tool returns a
 * plain error the model relays instead of running.
 */
function guardTools<T extends Record<string, unknown>>(tools: T, userId: string, isPremium: boolean): T {
  for (const t of Object.values(tools)) {
    const tool = t as { execute?: (...args: unknown[]) => unknown };
    const run = tool.execute;
    if (typeof run !== "function") continue;
    tool.execute = async (...args: unknown[]) => {
      const budget = await checkToolBudget(userId, isPremium);
      if (!budget.allowed) return { error: budget.reason };
      return run.apply(tool, args);
    };
  }
  return tools;
}

/**
 * AI SDK v6 puts all parts from a multi-step round-trip into a single
 * assistant CoreMessage: [text_before, tool-call, text_after].
 *
 * text_after is logically produced AFTER the tool result, so placing it
 * before the tool-result message confuses models (they see "I already have
 * the answer" + "call the tool" simultaneously). This function repairs the
 * messages array:
 *   BEFORE: assistant[text_before, tool-call, text_after] → tool[result] → …
 *   AFTER:  assistant[text_before, tool-call] → tool[result] → assistant[text_after] → …
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function repairToolMessages(msgs: any[]): any[] {
  const result: any[] = [];

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    const content = msg.content as Array<{ type: string; [k: string]: unknown }>;
    const toolCallIdx = content.findIndex((p) => p.type === "tool-call");

    if (toolCallIdx === -1) {
      // No tool call — nothing to repair
      result.push(msg);
      continue;
    }

    // Check if the NEXT message is a tool result (makes the post-tool split meaningful)
    const nextMsg = msgs[i + 1];
    const nextIsToolResult =
      nextMsg?.role === "tool" ||
      (nextMsg?.role === "assistant" && Array.isArray(nextMsg.content) &&
        (nextMsg.content as Array<{ type: string }>).some((p) => p.type === "tool-result"));

    if (!nextIsToolResult) {
      result.push(msg);
      continue;
    }

    // Split: parts up to and including the last tool-call go into the current message;
    // any text parts that come AFTER the last tool-call move to a new assistant message.
    const lastToolCallIdx = content.reduce(
      (last, p, idx) => (p.type === "tool-call" ? idx : last),
      -1,
    );

    const before = content.slice(0, lastToolCallIdx + 1);
    const after = content.slice(lastToolCallIdx + 1).filter((p) => p.type === "text");

    result.push({ ...msg, content: before });

    // Collect all tool-result messages that follow before inserting the continuation
    let j = i + 1;
    while (j < msgs.length && (msgs[j].role === "tool" ||
      (msgs[j].role === "assistant" && Array.isArray(msgs[j].content) &&
        (msgs[j].content as Array<{ type: string }>).some((p) => p.type === "tool-result")))) {
      result.push(msgs[j]);
      j++;
    }
    i = j - 1; // advance outer loop past consumed tool-result messages

    // Insert the post-tool text as a new assistant message (if any)
    if (after.length > 0) {
      result.push({ role: "assistant", content: after });
    }
  }

  return result;
}

/** How long the live XRP balance may delay a chat reply before the dashboard's polled value is used instead. */
const XRP_BALANCE_WAIT_MS = 2_500;

/** The user's XRPL sidebar wallet address and, when bluvfi-xrpl answers in time, its live balance. Never throws. */
async function lookupXrpWallet(userId: string): Promise<{ address?: string; balance?: number }> {
  try {
    const [sidebarWallet] = await db.select().from(xrplSidebarWallets).where(eq(xrplSidebarWallets.userId, userId)).limit(1);
    if (!sidebarWallet) return {};
    try {
      const wallet = await Promise.race([
        getWalletRequest(sidebarWallet.walletRequestId, { includeLedgerBalance: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bluvfi-xrpl timed out")), XRP_BALANCE_WAIT_MS)),
      ]);
      return { address: sidebarWallet.address, balance: resolveXrpBalance(wallet) };
    } catch {
      // bluvfi-xrpl is down or slow: the caller falls back to the dashboard's polled balance.
      return { address: sidebarWallet.address };
    }
  } catch (err) {
    // DB query failed — chat remains available.
    console.warn("[chat] failed to resolve XRP wallet:", err);
    return {};
  }
}

export async function POST(req: Request) {
  // Where a slow reply spends its time, logged once per request as "[chat] timing ..." (milliseconds since the request began).
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = (label: string) => {
    marks[label] = Date.now() - t0;
  };
  let userId: string;
  try {
    const auth = await verifyAuth();
    userId = auth.userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  // ── Per-user rate limiting (burst + daily) ──────────────────────────────
  // Checked after auth so we rate-limit by user identity, not just IP.
  // IP-based limits in proxy.ts are still the outer gate for unauthenticated abuse.
  // The XRP wallet row and its live balance are only needed for the prompt, so start them now and let them run while
  // the premium and limit checks below wait on their own round trips (awaited just before the prompt is built).
  const xrpLookup = lookupXrpWallet(userId);
  const isPremium = await isUserPremium(userId);
  mark("premium");
  // The token budget is a read-only peek, so it can share the limit check's round trip.
  const [rateLimit, tokenBudget] = await Promise.all([checkChatLimit(userId, isPremium), checkChatTokenBudget(userId, isPremium)]);
  mark("limits");
  if (!rateLimit.allowed) {
    return Response.json(
      { error: rateLimit.reason },
      { status: 429, headers: rateLimit.headers },
    );
  }

  // Cost budgets: LLM tokens used today, and an oversized-body guard. Rejections give the message back.
  if (!tokenBudget.allowed) {
    await refundChat(userId);
    return Response.json({ error: tokenBudget.reason }, { status: 429, headers: tokenBudget.headers });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    await refundChat(userId);
    return new Response("Request too large", { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    await refundChat(userId);
    return new Response("Invalid JSON", { status: 400 });
  }

  const {
    messages,
    walletAddress,
    solanaAddress,
    userName,
    evmUsdc,
    evmUsdt,
    solUsdc,
    solUsdt,
    xrpBalanceClient,
    paidBillIds,
    totalBillsDueUsd,
    portfolioValueUsd,
    billCount,
    appVersion,
    client,
    connectedWallet,
    walletOnly,
    seeker,
  } = body as {
    messages: UIMessage[];
    walletAddress?: string;
    solanaAddress?: string;
    userName?: string;
    evmUsdc?: number;
    evmUsdt?: number;
    solUsdc?: number;
    solUsdt?: number;
    xrpBalanceClient?: number;
    paidBillIds?: string[];
    totalBillsDueUsd?: number;
    portfolioValueUsd?: number;
    billCount?: number;
    appVersion?: string;
    /** "expo-android" from the native app; absent on the website and the older WebView app. */
    client?: string;
    connectedWallet?: { name?: string; address?: string };
    walletOnly?: boolean;
    seeker?: boolean;
  };

  if (!Array.isArray(messages)) {
    await refundChat(userId);
    return new Response("messages must be an array", { status: 400 });
  }

  const tools = guardTools(createTools(walletAddress, userId, solanaAddress, Array.isArray(paidBillIds) ? paidBillIds : [], userName, typeof client === "string" ? client : undefined), userId, isPremium);
  const recap = extractConversationRecap(messages);
  const windowed = windowMessages(messages);
  if (JSON.stringify(windowed).length > MAX_CONTEXT_CHARS) {
    await refundChat(userId);
    return new Response("Conversation too large", { status: 413 });
  }

  // The XRP wallet address (DB) and live balance (bluvfi-xrpl) were looked up while the limit checks ran. The client sends
  // xrpBalanceClient — the dashboard's polled value — as a fallback so the agent always sees a balance even when
  // bluvfi-xrpl is slow or down.
  const xrp = await xrpLookup;
  mark("xrp");
  const xrplAddress: string | undefined = xrp.address;
  let xrpBalance: number | undefined = xrp.balance;
  if (xrplAddress && xrpBalance === undefined && typeof xrpBalanceClient === "number" && Number.isFinite(xrpBalanceClient)) {
    xrpBalance = xrpBalanceClient;
  }

  let modelMessages;
  try {
    modelMessages = repairToolMessages(
      await convertToModelMessages(windowed, { ignoreIncompleteToolCalls: true }),
    );
    console.debug('[chat] modelMessages count:', modelMessages.length, 'roles:', modelMessages.map((m: { role: string }) => m.role).join('->'));
  } catch (err) {
    console.error('[chat] convertToModelMessages failed:', err);
    await refundChat(userId);
    return new Response('Message conversion failed', { status: 500 });
  }

  const system = buildSystemPrompt({
    userName,
    walletAddress,
    solanaAddress,
    evmUsdc,
    evmUsdt,
    solUsdc,
    solUsdt,
    xrplAddress,
    xrpBalance,
    totalBillsDueUsd,
    portfolioValueUsd,
    billCount,
    conversationRecap: recap || undefined,
    // Only the reference sections the conversation touches go to the model (smaller prompt, faster first word).
    topicText: conversationTopics(windowed, recap),
    currentDate: new Date().toISOString().slice(0, 10),
    appVersion: typeof appVersion === "string" ? appVersion : undefined,
    client: typeof client === "string" ? client : undefined,
    connectedWallet:
      connectedWallet && typeof connectedWallet === "object"
        ? { name: String(connectedWallet.name ?? ""), address: String(connectedWallet.address ?? "") }
        : undefined,
    walletOnly: walletOnly === true,
    seeker: seeker === true,
  });

  // ── Cross-provider fallback ────────────────────────────────────────────
  // Try the configured provider first (AI_PROVIDER); if it fails before any
  // tokens reach the client, transparently retry on the next provider with a
  // key configured (e.g. Qwen down → OpenAI, or vice versa). Once a chunk has
  // actually been streamed to the user it's too late to switch providers
  // mid-response — that residual case still surfaces via onError below.
  mark("prompt");
  let candidates;
  try {
    candidates = getLanguageModelCandidates();
  } catch (err) {
    console.error('[chat] no AI provider configured:', err);
    await refundChat(userId);
    return new Response('AI service error', { status: 503 });
  }

  let lastErr: unknown;
  for (const { name, model } of candidates) {
    try {
      const result = streamText({
        model,
        system,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(10),
        // What the request actually cost, against the user's daily token budget.
        onFinish: ({ totalUsage, steps }) => {
          mark("done");
          console.info(
            "[chat] timing",
            JSON.stringify({ ms: marks, model: (model as { modelId?: string }).modelId ?? name, steps: steps?.length ?? 1, tokens: totalUsage?.totalTokens ?? 0, promptChars: system.length }),
          );
          void recordChatTokens(userId, totalUsage?.totalTokens ?? 0);
        },
        onError: (err) => {
        const modelId = (model as { modelId?: string }).modelId ?? name;
        console.error(`[chat] ${name} (${modelId}) streamText error (mid-stream):`, err);
      },
      });
      const response = result.toUIMessageStreamResponse({ headers: rateLimit.headers });

      // Peek the first chunk before committing this provider's response to
      // the client — if it throws or the stream is empty, the failure
      // happened before any output was produced and it's safe to retry.
      const reader = response.body!.getReader();
      const first = await reader.read();
      mark("firstChunk");
      if (first.done) throw new Error(`${name} returned an empty stream`);

      // DashScope quota errors (AllocationQuota.FreeTierOnly) arrive as the
      // first SSE event after an HTTP 200 — the connection looks alive so the
      // catch block above never fires. Decode the first chunk and look for the
      // AI SDK data-stream error prefix ("3:"). If found, throw so the loop
      // moves on to the next candidate before any bytes reach the client.
      const firstText = new TextDecoder().decode(first.value);
      if (firstText.split('\n').some(line => line.startsWith('3:'))) {
        throw new Error(`${name} returned an error event: ${firstText.slice(0, 300)}`);
      }

      const replay = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first.value);
        },
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        },
        cancel(reason) { reader.cancel(reason).catch(() => {}); },
      });
      return new Response(replay, { headers: response.headers, status: response.status });
    } catch (err) {
      console.error(`[chat] ${name} failed before first token, trying next provider:`, err);
      lastErr = err;
    }
  }

  console.error('[chat] all AI providers failed:', lastErr);
  await refundChat(userId);
  return new Response('AI service error', { status: 503 });
}
