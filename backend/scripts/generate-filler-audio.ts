// One-time (rerun-when-you-want-different-phrases) script: generates short
// "thinking" filler clips in the SAME Gemini voice the live conversation
// uses, so the filler sounds like the same teacher talking, not a jarring
// switch to the browser's generic system TTS voice.
//
// Run from backend/: npx tsx scripts/generate-filler-audio.ts
// Output: frontend/public/filler/*.wav (checked in — no need to regenerate
// unless you change GEMINI_LIVE_VOICE or want different phrases).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../../frontend/public/filler");

const MODEL = process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-latest";
const VOICE_NAME = process.env.GEMINI_LIVE_VOICE ?? "Aoede";

// Natural, short, code-switched the same way the real persona speaks —
// see teacherPersona.ts's LANGUAGE section for why (no translate-twice).
const PHRASES = [
  "hmm-1",
  "let-me-think",
  "ooh-good-question",
  "aalochistunnanu",
  "oka-nimisham",
] as const;

const PROMPTS: Record<(typeof PHRASES)[number], string> = {
  "hmm-1": "Hmm...",
  "let-me-think": "Let me think for a second...",
  "ooh-good-question": "Ooh, good question!",
  "aalochistunnanu": "ఆలోచిస్తున్నాను...",
  "oka-nimisham": "ఒక్క నిమిషం...",
};

const SYSTEM_INSTRUCTION = `
You are recording short voice clips for a toddler AI teacher app, in the
app's own warm, playful voice. When given a line starting with "SAY:",
speak EXACTLY that text, warmly and briefly, and say absolutely nothing
else before or after it — no greeting, no extra words, no explanation.
`.trim();

function writeWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

async function generateOne(ai: GoogleGenAI, id: string, text: string): Promise<void> {
  const chunks: Buffer[] = [];
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));

  const session = await ai.live.connect({
    model: MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: SYSTEM_INSTRUCTION,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
    },
    callbacks: {
      onmessage: (message: LiveServerMessage) => {
        const audioPart = message.serverContent?.modelTurn?.parts?.find((p) => p.inlineData?.data);
        if (audioPart?.inlineData?.data) chunks.push(Buffer.from(audioPart.inlineData.data, "base64"));
        if (message.serverContent?.turnComplete) resolveDone();
      },
      onerror: (e) => console.error(`  error generating "${id}":`, e.message),
      onclose: () => resolveDone(),
    },
  });

  session.sendClientContent({ turns: `SAY: ${text}`, turnComplete: true });

  await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
  session.close();

  const pcm = Buffer.concat(chunks);
  if (pcm.length === 0) {
    console.error(`  ⚠️  no audio received for "${id}" — skipping`);
    return;
  }
  const wav = writeWav(pcm, 24000);
  fs.writeFileSync(path.join(OUT_DIR, `${id}.wav`), wav);
  console.log(`  ✅ ${id}.wav (${(wav.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY not set — see backend/.env.example");
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });

  // Pass phrase ids as argv to regenerate only those (e.g. after a retry
  // for one that failed) instead of every clip every time.
  const requested = process.argv.slice(2);
  const toGenerate = requested.length > 0 ? PHRASES.filter((id) => requested.includes(id)) : PHRASES;

  console.log(`🎙️  Generating ${toGenerate.length} filler clip(s) with voice "${VOICE_NAME}"...`);
  for (const id of toGenerate) {
    await generateOne(ai, id, PROMPTS[id]);
  }
  console.log("🎯 Done.");
}

main();
