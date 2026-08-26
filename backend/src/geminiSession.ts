// Wraps one Gemini Live API session for one connected child/browser.
//
// NOTE: the Gemini Live API (model names, exact SDK method shapes) moves
// fast. This is written against the documented @google/genai `ai.live`
// surface at the time this was built. If Google has since renamed things,
// check https://ai.google.dev/gemini-api/docs/live and adjust here — the
// relay protocol to the frontend (voiceSocket.ts) does not need to change.

import { ActivityHandling, GoogleGenAI, Modality, Session, LiveServerMessage } from "@google/genai";
import { TEACHER_SYSTEM_INSTRUCTION } from "./teacherPersona.js";

const MODEL = process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-latest";
const VOICE_NAME = process.env.GEMINI_LIVE_VOICE ?? "Aoede";

export interface GeminiSessionCallbacks {
  onAudio: (pcm: Buffer) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export class GeminiVoiceSession {
  private session: Session | null = null;
  private connecting: Promise<void>;
  // An interrupted turn still sends its own trailing turnComplete afterward
  // (per the SDK: "interrupted > turn_complete") - that's Gemini closing out
  // the *old*, already-discarded turn, not completion of whatever the child
  // just asked instead. Swallow exactly that one stray completion so it
  // can't flip the frontend back to "ready" mid-way through the real answer.
  private suppressNextTurnComplete = false;

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
          // The UI is push-to-talk (the button press/release IS the turn
          // boundary), so let the client say exactly when speech starts and
          // ends instead of Gemini's own silence-duration VAD guessing it -
          // that guess defaults to a multi-second pause-before-committing,
          // which was adding most of the perceived response latency.
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: true },
            // A fresh activityStart while Gemini is still talking cuts its
            // current response off ("barge in") — this is Gemini's own
            // default, but set explicitly since the frontend's ability to
            // interrupt depends on it and shouldn't silently break if
            // Google ever changes the default.
            activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
          },
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (message.serverContent?.interrupted) {
              this.suppressNextTurnComplete = true;
              callbacks.onInterrupted();
            }

            const audioPart = message.serverContent?.modelTurn?.parts?.find(
              (p) => p.inlineData?.data
            );
            if (audioPart?.inlineData?.data) {
              callbacks.onAudio(Buffer.from(audioPart.inlineData.data, "base64"));
            }

            if (message.serverContent?.turnComplete) {
              if (this.suppressNextTurnComplete) {
                this.suppressNextTurnComplete = false;
              } else {
                callbacks.onTurnComplete();
              }
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

  /** Call when the button is pressed, before the first audio chunk. */
  startTurn(): void {
    this.session?.sendRealtimeInput({ activityStart: {} });
  }

  sendAudioChunk(pcm16Mono16k: Buffer): void {
    this.session?.sendRealtimeInput({
      audio: { data: pcm16Mono16k.toString("base64"), mimeType: "audio/pcm;rate=16000" },
    });
  }

  /** Call when the button is released — with automatic VAD disabled, this
   * (not silence detection) is what tells Gemini the child is done talking. */
  endTurn(): void {
    this.session?.sendRealtimeInput({ activityEnd: {} });
  }

  close(): void {
    this.session?.close();
  }
}
