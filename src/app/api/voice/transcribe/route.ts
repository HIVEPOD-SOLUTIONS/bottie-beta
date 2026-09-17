import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { verifyAuth } from "@/lib/auth";
import { checkVoiceLimit } from "@/lib/user-rate-limiter";

export const maxDuration = 30;

export async function POST(req: Request) {
  let userId: string;
  try {
    ({ userId } = await verifyAuth());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const rateLimit = checkVoiceLimit(userId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: rateLimit.reason },
      { status: 429, headers: rateLimit.headers },
    );
  }

  const GEMINI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "Voice transcription not configured" },
      { status: 500 },
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request format" }, { status: 400 });
  }

  const audioFile = formData.get("audio") as File | null;
  if (!audioFile) {
    return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
  }

  const MAX_FILE_SIZE = 20 * 1024 * 1024;
  if (audioFile.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "Audio file too large (max 20MB)" }, { status: 413 });
  }

  try {
    const arrayBuffer = await audioFile.arrayBuffer();
    const base64Audio = Buffer.from(arrayBuffer).toString("base64");

    const mimeType = (audioFile.type || "audio/webm") as string;

    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Audio,
              },
            },
            {
              text: "Transcribe the audio exactly. Return only the transcribed text with no commentary, labels, or punctuation changes.",
            },
          ],
        },
      ],
    });

    const text = response.text?.trim() ?? "";
    if (!text) {
      return NextResponse.json({ error: "Could not transcribe audio" }, { status: 422 });
    }

    return NextResponse.json({ text });
  } catch (err) {
    console.error("[Voice] Gemini transcription error:", err);
    return NextResponse.json(
      { error: "Transcription failed. Please try again." },
      { status: 502 },
    );
  }
}
