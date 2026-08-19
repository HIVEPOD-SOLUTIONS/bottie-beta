import { openai, createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * AI provider selection + cross-provider fallback.
 *
 * Set AI_PROVIDER=qwen (+ QWEN_API_KEY) to prefer Qwen Cloud.
 * Default: OpenAI gpt-4o-mini.
 *
 * Qwen Cloud is OpenAI-compatible, so we reuse @ai-sdk/openai with a
 * custom baseURL — no extra package needed.
 *
 * getLanguageModelCandidates() returns the preferred provider first, then
 * any other provider that has an API key configured, so the caller can try
 * the primary and transparently fall back if it fails — e.g. AI_PROVIDER=qwen
 * with QWEN down but OPENAI_API_KEY present still serves the request instead
 * of hard-failing.
 */

export type ModelCandidate = { name: "openai" | "qwen"; model: LanguageModel };

function buildQwenModel(): LanguageModel {
  const apiKey = process.env.QWEN_API_KEY;
  if (!apiKey) throw new Error("QWEN_API_KEY is not set");

  // Qwen (DashScope) rejects the 'developer' role that AI SDK v6 uses for
  // system messages. Remap it to 'system' at the fetch layer.
  const remapFetch: typeof fetch = async (url, init) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (Array.isArray(body.messages)) {
          body.messages = body.messages.map((m: { role: string }) =>
            m.role === "developer" ? { ...m, role: "system" } : m,
          );
        }
        init = { ...init, body: JSON.stringify(body) };
      } catch {
        // leave body unchanged if parsing fails
      }
    }
    return fetch(url, init);
  };

  const qwen = createOpenAI({
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKey,
    fetch: remapFetch,
  });

  const model = process.env.QWEN_MODEL ?? "qwen-plus";
  // Use Chat Completions format — Qwen's compatible-mode endpoint does not
  // support the OpenAI Responses API format that qwen(model) defaults to.
  return qwen.chat(model) as LanguageModel;
}

function buildOpenAiModel(): LanguageModel {
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  return openai(model) as LanguageModel;
}

/**
 * Ordered list of usable providers: the one selected by AI_PROVIDER first
 * (if its key is configured), then any other provider with a key present, as
 * a fallback candidate. Providers with no key at all are omitted — there's
 * nothing to fall back to if it was never configured.
 */
export function getLanguageModelCandidates(): ModelCandidate[] {
  const preferred = (process.env.AI_PROVIDER ?? "openai").toLowerCase();
  const hasQwenKey = !!process.env.QWEN_API_KEY;
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY;

  const order: Array<"openai" | "qwen"> =
    preferred === "qwen" ? ["qwen", "openai"] : ["openai", "qwen"];

  const candidates: ModelCandidate[] = [];
  for (const name of order) {
    if (name === "qwen" && hasQwenKey) candidates.push({ name, model: buildQwenModel() });
    if (name === "openai" && hasOpenAiKey) candidates.push({ name, model: buildOpenAiModel() });
  }

  if (candidates.length === 0) {
    // Neither key detected — surface the same clear error the old code gave
    // for the preferred provider, rather than silently doing nothing.
    if (preferred === "qwen") throw new Error("QWEN_API_KEY is not set");
    throw new Error("OPENAI_API_KEY is not set");
  }

  return candidates;
}

/** Back-compat: returns just the preferred provider's model (no fallback list). */
export function getLanguageModel(): LanguageModel {
  return getLanguageModelCandidates()[0].model;
}
