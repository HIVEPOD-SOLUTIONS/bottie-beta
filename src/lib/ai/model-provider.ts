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

// Ordered list of Qwen text models to try when AI_PROVIDER=qwen.
// Most capable first; flash models last as high-availability fallbacks.
// Each has a 1M-token free quota on DashScope — if one's quota is exhausted
// the chat route automatically retries the next one in the list.
const QWEN_MODEL_FALLBACK_CHAIN = [
  "qwen3.6-max-preview",
  "qwen3.7-max-preview",
  "qwen3.7-max-2026-05-17",
  "qwen3.6-plus",
  "qwen3.7-plus",
  "qwen3.5-plus",
  "qwen3-max",
  "qwen3.7-flash",
  "qwen3.6-flash",
  "qwen3.5-flash",
  "qwen-plus-2025-12-01",
];

function buildQwenCandidates(): LanguageModel[] {
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

  // If QWEN_MODEL is explicitly set, put it first; otherwise use the full chain.
  const primary = process.env.QWEN_MODEL;
  const chain = primary
    ? [primary, ...QWEN_MODEL_FALLBACK_CHAIN.filter((m) => m !== primary)]
    : QWEN_MODEL_FALLBACK_CHAIN;

  // Use Chat Completions format — Qwen's compatible-mode endpoint does not
  // support the OpenAI Responses API format that qwen(model) defaults to.
  return chain.map((modelId) => qwen.chat(modelId) as LanguageModel);
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

  const candidates: ModelCandidate[] = [];

  if (preferred === "qwen") {
    // All Qwen models in priority order, then OpenAI as the final fallback.
    if (hasQwenKey) {
      for (const model of buildQwenCandidates()) {
        candidates.push({ name: "qwen", model });
      }
    }
    if (hasOpenAiKey) candidates.push({ name: "openai", model: buildOpenAiModel() });
  } else {
    // OpenAI first, then Qwen models as fallbacks.
    if (hasOpenAiKey) candidates.push({ name: "openai", model: buildOpenAiModel() });
    if (hasQwenKey) {
      for (const model of buildQwenCandidates()) {
        candidates.push({ name: "qwen", model });
      }
    }
  }

  if (candidates.length === 0) {
    if (preferred === "qwen") throw new Error("QWEN_API_KEY is not set");
    throw new Error("OPENAI_API_KEY is not set");
  }

  return candidates;
}

/** Back-compat: returns the first (highest-priority) model. */
export function getLanguageModel(): LanguageModel {
  return getLanguageModelCandidates()[0].model;
}
