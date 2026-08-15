/**
 * Shared Gemini client using @google/genai (the new Google Interactions API).
 *
 * The old `@ai-sdk/google` wrapper used the deprecated v1beta/generateContent
 * endpoint which is no longer available for new API keys. This module uses
 * Google's official SDK which targets the current Interactions API.
 *
 * Model: gemini-3.6-flash — confirmed working on new API keys (Aug 2026).
 * Swap to gemini-3.7-flash or gemini-2.5-pro when availability improves.
 */

import { GoogleGenAI } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.6-flash";

let _client: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

/**
 * Simple wrapper: system + user prompt → plain text response.
 * Throws on API error so callers can catch and handle gracefully.
 */
export async function geminiGenerateText({
  system,
  prompt,
  model = GEMINI_MODEL,
}: {
  system: string;
  prompt: string;
  model?: string;
}): Promise<string> {
  const client = getGeminiClient();
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction: system,
    },
  });
  const text = response.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Gemini returned empty response");
  }
  return text.trim();
}
