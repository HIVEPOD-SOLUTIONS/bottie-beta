import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { checkVoiceLimit } from "@/lib/user-rate-limiter";

// Whisper transcription can take a few seconds for long audio clips.
export const maxDuration = 30;

const OPENAI_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODEL = "whisper-1";

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  // Per-user rate limit — Whisper is billed per audio-minute.
  const rateLimit = checkVoiceLimit(userId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: rateLimit.reason },
      { status: 429, headers: rateLimit.headers },
    );
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Voice transcription not configured" },
      { status: 500 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid request format" },
      { status: 400 },
    );
  }

  const audioFile = formData.get("audio") as File | null;
  if (!audioFile) {
    return NextResponse.json(
      { error: "No audio file provided" },
      { status: 400 },
    );
  }

  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  if (audioFile.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "Audio file too large (max 25MB)" },
      { status: 413 },
    );
  }

  const openaiFormData = new FormData();
  openaiFormData.append("file", audioFile);
  openaiFormData.append("model", OPENAI_MODEL);
  openaiFormData.append("language", "en");
  openaiFormData.append("response_format", "json");
  openaiFormData.append("temperature", "0");

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: openaiFormData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Voice] OpenAI API error:", response.status, errorText);
      if (response.status === 429) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Please try again later." },
          { status: 429 },
        );
      }
      return NextResponse.json(
        { error: "Transcription failed. Please try again." },
        { status: response.status },
      );
    }

    const result = await response.json();
    if (typeof result.text !== "string") {
      return NextResponse.json(
        { error: "Invalid transcription response" },
        { status: 502 },
      );
    }

    return NextResponse.json({ text: result.text });
  } catch {
    return NextResponse.json(
      { error: "Network error. Please check your connection." },
      { status: 502 },
    );
  }
}
