// Turns one session's raw transcript into a short, structured summary —
// this is the piece that makes "session memory" possible: geminiSession.ts
// only ever sees one conversation, so something has to distill it down
// into a few facts that are worth remembering for *next* time.
//
// Uses a plain (non-Live) text call to Gemini, separate from the live
// voice session — summarization has no latency requirement the way a live
// conversation does, so there's no reason to route it through the
// real-time API.

import { GoogleGenAI, Type } from "@google/genai";

const SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL ?? "gemini-3.6-flash";

// Transcripts are transcribed toddler speech, which can be long and messy —
// cap what we send so one very long session can't blow up the prompt size
// or the cost of summarizing it. The most recent part of the conversation
// is what matters most for "what did we just cover."
const MAX_TRANSCRIPT_CHARS = 8000;

export interface SessionSummary {
  topics: string[];
  newWords: string[];
  strugglingWords: string[];
  summaryForParent: string;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    topics: { type: Type.ARRAY, items: { type: Type.STRING } },
    newWords: { type: Type.ARRAY, items: { type: Type.STRING } },
    strugglingWords: { type: Type.ARRAY, items: { type: Type.STRING } },
    summaryForParent: { type: Type.STRING },
  },
  required: ["topics", "newWords", "strugglingWords", "summaryForParent"],
};

function buildPrompt(transcript: string): string {
  return `You are analyzing a transcript of a spoken conversation between a
young toddler (2-5 years old) and an AI voice teacher. The transcript is
auto-transcribed from real speech, so expect fragments, repeated words,
and occasional mixed English/Telugu — do your best with what's there.

Read the transcript and extract:
- topics: 1-5 short topic tags actually covered (e.g. "animals", "colors",
  "counting", "elephants"), not generic ones like "conversation".
- newWords: individual words or short phrases the teacher introduced or
  the child practiced saying, that seem worth remembering for next time.
  Keep this to concrete vocabulary (e.g. "elephant", "red", "మూడు"), not
  full sentences.
- strugglingWords: words the child clearly had trouble with or needed
  repeated (only include ones with real evidence in the transcript — leave
  empty if nothing stands out).
- summaryForParent: one warm, specific sentence a parent would enjoy
  reading, e.g. "Today we talked about farm animals and practiced counting
  to five in Telugu!" Never mention that this was AI-generated or refer to
  "the transcript."

If the transcript is too short or unclear to say anything meaningful,
return empty arrays and a short neutral summaryForParent like "A quick
chat today!" — never invent topics or words that aren't actually there.

TRANSCRIPT:
${transcript}`;
}

/**
 * Returns null (never throws) on any failure — a missing/malformed summary
 * should never take down the backend or block anything else. Session
 * memory is a nice-to-have on top of the core voice experience, not a
 * dependency of it.
 */
export async function summarizeSession(apiKey: string, transcript: string): Promise<SessionSummary | null> {
  const trimmed = transcript.trim();
  if (!trimmed) return null;

  const truncated =
    trimmed.length > MAX_TRANSCRIPT_CHARS ? trimmed.slice(-MAX_TRANSCRIPT_CHARS) : trimmed;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: SUMMARY_MODEL,
      contents: buildPrompt(truncated),
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const text = response.text;
    if (!text) return null;
    const parsed = JSON.parse(text);

    return {
      topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t: unknown) => typeof t === "string") : [],
      newWords: Array.isArray(parsed.newWords) ? parsed.newWords.filter((t: unknown) => typeof t === "string") : [],
      strugglingWords: Array.isArray(parsed.strugglingWords)
        ? parsed.strugglingWords.filter((t: unknown) => typeof t === "string")
        : [],
      summaryForParent: typeof parsed.summaryForParent === "string" ? parsed.summaryForParent : "A quick chat today!",
    };
  } catch (err) {
    console.error("Session summarization failed (non-fatal):", err);
    return null;
  }
}
