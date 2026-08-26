// Wraps one Gemini Live API session for one connected child/browser.
//
// NOTE: the Gemini Live API (model names, exact SDK method shapes) moves
// fast. This is written against the documented @google/genai `ai.live`
// surface at the time this was built. If Google has since renamed things,
// check https://ai.google.dev/gemini-api/docs/live and adjust here — the
// relay protocol to the frontend (voiceSocket.ts) does not need to change.

import { GoogleGenAI, Modality, Session, LiveServerMessage } from "@google/genai";
import { TEACHER_SYSTEM_INSTRUCTION } from "./teacherPersona.js";

const MODEL = process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-latest";
const VOICE_NAME = process.env.GEMINI_LIVE_VOICE ?? "Aoede";

export interface GeminiSessionCallbacks {
  onAudio: (pcm: Buffer) => void;
  onTurnComplete: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export class GeminiVoiceSession {
  private session: Session | null = null;
  private connecting: Promise<void>;

  constructor(apiKey: string, callbacks: GeminiSessionCallbacks) {
    // v1beta doesn't have the live-capable models available for every key;
    // v1alpha does. See geminiSession.ts's module comment.
    const ai = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });

    this.connecting = ai.live
      .connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: TEACHER_SYSTEM_INSTRUCTION,
          // No languageCode set deliberately — the child switches between
          // English and Telugu (and mixes them) freely, so we don't want
          // to pin the session to a single language.
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
          },
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const audioPart = message.serverContent?.modelTurn?.parts?.find(
              (p) => p.inlineData?.data
            );
            if (audioPart?.inlineData?.data) {
              callbacks.onAudio(Buffer.from(audioPart.inlineData.data, "base64"));
            }
            if (message.serverContent?.turnComplete) {
              callbacks.onTurnComplete();
            }
          },
          onerror: (event) => {
            console.error("Gemini Live onerror:", event);
            callbacks.onError(event.message || "Gemini Live session error");
          },
          onclose: (event) => {
            console.error("Gemini Live onclose:", event?.code, event?.reason);
            callbacks.onClose();
          },
        },
      })
      .then((session) => {
        this.session = session;
      });
  }

  /** Resolves once the underlying Gemini Live session is open (or rejects if connect failed). */
  ready(): Promise<void> {
    return this.connecting;
  }

  sendAudioChunk(pcm16Mono16k: Buffer): void {
    this.session?.sendRealtimeInput({
      audio: { data: pcm16Mono16k.toString("base64"), mimeType: "audio/pcm;rate=16000" },
    });
  }

  endTurn(): void {
    // Gemini Live also detects end-of-turn via voice-activity-detection on
    // its own; this explicit signal just makes push-to-talk (button
    // release) feel immediate instead of waiting on VAD silence timeout.
    this.session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  close(): void {
    this.session?.close();
  }
}
