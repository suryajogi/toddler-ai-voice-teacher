// Wraps one Gemini Live API session for one connected child/browser.
//
// NOTE: the Gemini Live API (model names, exact SDK method shapes) moves
// fast. This is written against the documented @google/genai `ai.live`
// surface at the time this was built. If Google has since renamed things,
// check https://ai.google.dev/gemini-api/docs/live and adjust here — the
// relay protocol to the frontend (voiceSocket.ts) does not need to change.

import {
  ActivityHandling,
  FunctionCall,
  FunctionDeclaration,
  FunctionResponse,
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Session,
  Type,
} from "@google/genai";
import { buildTeacherSystemInstruction } from "./teacherPersona.js";
import { detectSideConversation } from "./audioProcessingEngine.js";
import { analyzeAndExtractProfileFacts, recordInteractionMetric } from "./botMemoryEngine.js";

const MODEL = process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-latest";
const VOICE_NAME = process.env.GEMINI_LIVE_VOICE ?? "Aoede";

// Screen themes set_scene is allowed to pick from — kept as a fixed enum
// (rather than free text) so the frontend only ever needs to style a known,
// small set of moods (see frontend/app/page.tsx's SCENE_THEME map).
const SCENE_THEMES = ["jungle", "space", "ocean", "party", "calm"] as const;

// Tools the model can call mid-conversation to react on the child's screen
// (see teacherPersona.ts's "USING YOUR SCREEN TOOLS" section for how it's
// told to use them). Both are pure UI side effects with nothing for the
// backend itself to compute, so every call is acknowledged immediately
// with a trivial "ok" response — see handleToolCall below.
const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "show_emoji",
    description:
      "Flashes one big emoji on the child's screen — e.g. to illustrate an animal, object, color, or number just mentioned, or to celebrate something the child did well.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        emoji: { type: Type.STRING, description: 'A single emoji character, e.g. "🐘" or "🎉".' },
      },
      required: ["emoji"],
    },
  },
  {
    name: "set_scene",
    description: "Shifts the screen's background mood/theme to match the current topic.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        theme: { type: Type.STRING, enum: [...SCENE_THEMES] },
      },
      required: ["theme"],
    },
  },
];

export interface GeminiSessionCallbacks {
  onAudio: (pcm: Buffer) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  /** The model called one of the screen tools above — relay it to the browser. */
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  /** The connection dropped unexpectedly and a resume attempt is starting. */
  onReconnecting: () => void;
  /** The resume attempt above succeeded — the session is live again. */
  onReconnected: () => void;
  /** This turn was classified as a side conversation (see
   * audioProcessingEngine.ts) — the child wasn't talking to the bot, so no
   * audio was played back, on purpose. Facts are still extracted from it
   * in the background; this just tells the frontend to quietly go back to
   * "ready" rather than treat it as a normal completed answer. */
  onPassiveListen: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export class GeminiVoiceSession {
  private readonly apiKey: string;
  private readonly callbacks: GeminiSessionCallbacks;
  private session: Session | null = null;
  private connecting: Promise<void>;

  // Distinguishes "we hung up on purpose" (server.ts calling close(), e.g.
  // because the browser disconnected) from "Gemini's own connection dropped
  // out from under us" — only the latter is worth trying to recover from.
  private intentionalClose = false;
  private hasReconnected = false; // one retry attempt, not an infinite loop
  private resumptionHandle: string | undefined;

  // An interrupted turn still sends its own trailing turnComplete afterward
  // (per the SDK: "interrupted > turn_complete") - that's Gemini closing out
  // the *old*, already-discarded turn, not completion of whatever the child
  // just asked instead. Swallow exactly that one stray completion so it
  // can't flip the frontend back to "ready" mid-way through the real answer.
  private suppressNextTurnComplete = false;

  // Best-effort running transcript, one line per finished turn — good
  // enough for sessionSummarizer.ts, not meant to be a perfect record.
  private transcriptLines: string[] = [];
  private currentInputText = "";
  private currentOutputText = "";

  // Set as soon as the child's just-finished utterance is classified as a
  // side conversation (see audioProcessingEngine.ts) — gates audio
  // relaying for the rest of *this* turn only, then resets. turnClassified
  // guards against re-running the (cheap, but not free) classification
  // more than once per turn if multiple inputTranscription.finished
  // signals arrive in a row.
  private suppressAudioThisTurn = false;
  private turnClassified = false;

  constructor(
    apiKey: string,
    callbacks: GeminiSessionCallbacks,
    private readonly childId: string,
    private readonly sessionId: string,
    memoryContext: string = ""
  ) {
    this.apiKey = apiKey;
    this.callbacks = callbacks;
    this.connecting = this.open(memoryContext);
  }

  private open(memoryContext: string, resumeHandle?: string): Promise<void> {
    // v1beta doesn't have the live-capable models available for every key;
    // v1alpha does. See this file's module comment.
    const ai = new GoogleGenAI({ apiKey: this.apiKey, apiVersion: "v1alpha" });

    return ai.live
      .connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: buildTeacherSystemInstruction(memoryContext, { includeScreenTools: true }),
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
          // Powers both the session-memory summary (server.ts persists a
          // transcript-derived summary on close) and, in principle, a
          // future on-screen subtitle — right now only the former is used.
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // Requesting this (even with no handle yet) makes the server send
          // sessionResumptionUpdate messages we can use to reconnect
          // transparently if the connection drops mid-conversation.
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => this.handleMessage(message),
          onerror: (event) => {
            console.error("Gemini Live onerror:", event);
            this.callbacks.onError(event.message || "Gemini Live session error");
          },
          onclose: (event) => {
            console.error("Gemini Live onclose:", event?.code, event?.reason);
            this.handleUnexpectedClose(memoryContext);
          },
        },
      })
      .then((session) => {
        this.session = session;
      });
  }

  private handleUnexpectedClose(memoryContext: string): void {
    if (this.intentionalClose) return; // we asked for this — nothing to recover from
    if (this.hasReconnected || !this.resumptionHandle) {
      this.callbacks.onClose();
      return;
    }
    this.hasReconnected = true;
    this.callbacks.onReconnecting();
    this.connecting = this.open(memoryContext, this.resumptionHandle)
      .then(() => this.callbacks.onReconnected())
      .catch((err) => {
        console.error("Gemini Live reconnect failed:", err);
        this.callbacks.onError("Lost connection to Gemini Live and could not reconnect.");
      });
  }

  private handleMessage(message: LiveServerMessage): void {
    if (message.serverContent?.interrupted) {
      this.suppressNextTurnComplete = true;
      this.callbacks.onInterrupted();
    }

    if (message.serverContent?.inputTranscription?.text) {
      this.currentInputText += message.serverContent.inputTranscription.text;
    }

    // Classify as soon as the child's utterance is fully transcribed —
    // this is often *before* Gemini's audio response starts arriving
    // (there's a real network/model gap between "child stopped talking"
    // and "first response chunk"), so most of the time this adds no
    // perceptible delay. Checked before the audio-forwarding block below
    // so a same-message audio chunk still respects the just-set flag.
    if (message.serverContent?.inputTranscription?.finished && !this.turnClassified) {
      this.turnClassified = true;
      const result = detectSideConversation([{ speaker: "child", text: this.currentInputText }]);
      this.suppressAudioThisTurn = result.isSideConversation;
      if (result.isSideConversation) {
        console.log(`Passive listening this turn (${result.reason}) — no audio will be played back.`);
      }
    }

    const audioPart = message.serverContent?.modelTurn?.parts?.find(
      (p) => p.inlineData?.data
    );
    if (audioPart?.inlineData?.data && !this.suppressAudioThisTurn) {
      this.callbacks.onAudio(Buffer.from(audioPart.inlineData.data, "base64"));
    }

    if (message.serverContent?.outputTranscription?.text) {
      this.currentOutputText += message.serverContent.outputTranscription.text;
    }

    if (message.toolCall?.functionCalls) {
      for (const call of message.toolCall.functionCalls) {
        this.handleToolCall(call);
      }
    }

    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
    }

    if (message.serverContent?.turnComplete) {
      const wasSideConversation = this.suppressAudioThisTurn;
      this.flushTranscriptTurn();
      if (this.suppressNextTurnComplete) {
        this.suppressNextTurnComplete = false;
      } else if (wasSideConversation) {
        this.callbacks.onPassiveListen();
      } else {
        this.callbacks.onTurnComplete();
      }
      this.suppressAudioThisTurn = false;
      this.turnClassified = false;
    }
  }

  private flushTranscriptTurn(): void {
    const child = this.currentInputText.trim();
    const teacher = this.currentOutputText.trim();
    if (child) {
      this.transcriptLines.push(`Child: ${child}`);
      // Fire-and-forget: neither call should ever hold up the live
      // conversation, or — since this runs synchronously inside the
      // Live API's onmessage callback, not inside a Promise chain — throw
      // an exception that takes down the whole backend process.
      // analyzeAndExtractProfileFacts already fails safe internally;
      // recordInteractionMetric doesn't, so it's wrapped here.
      void analyzeAndExtractProfileFacts(this.childId, [{ speaker: "child", text: child }]);
      try {
        recordInteractionMetric(this.sessionId, child);
      } catch (err) {
        console.error("recordInteractionMetric failed (non-fatal):", err);
      }
    }
    if (teacher) this.transcriptLines.push(`Teacher: ${teacher}`);
    this.currentInputText = "";
    this.currentOutputText = "";
  }

  private handleToolCall(call: FunctionCall): void {
    if (call.name) this.callbacks.onToolCall(call.name, call.args ?? {});
    // Every one of our tools is a pure, instant UI side effect — there's
    // nothing to compute, so acknowledge immediately rather than waiting on
    // anything (e.g. a round trip to the browser) that could stall Gemini
    // mid-conversation.
    const response: FunctionResponse = { id: call.id, name: call.name, response: { output: "ok" } };
    this.session?.sendToolResponse({ functionResponses: response });
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

  /** The best-effort transcript of this session so far, for summarization. */
  getTranscript(): string {
    return this.transcriptLines.join("\n");
  }

  close(): void {
    this.intentionalClose = true;
    this.session?.close();
  }
}
