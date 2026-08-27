"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { AudioPlayer, MicStreamer } from "@/lib/audio";
import { VoiceSocket } from "@/lib/voiceSocket";

const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:8081/voice";

type State = "connecting" | "ready" | "listening" | "responding" | "reconnecting" | "error";

const STATE_LABEL: Record<State, string> = {
  connecting: "Connecting…",
  ready: "Press and hold to talk!",
  listening: "I'm listening…",
  responding: "🧸 (press to ask something else!)",
  reconnecting: "One sec, reconnecting…",
  error: "Oops, something went wrong.",
};

const STATE_COLOR: Record<State, string> = {
  connecting: "bg-amber-300",
  ready: "bg-emerald-400 hover:bg-emerald-300 active:bg-emerald-500",
  listening: "bg-rose-400",
  responding: "bg-sky-400",
  reconnecting: "bg-amber-300",
  error: "bg-zinc-300",
};

// The set_scene tool (see backend/src/geminiSession.ts) only ever sends one
// of these five theme names — a fixed set so the frontend only ever needs
// to style a known, small palette rather than trust arbitrary AI output.
type SceneTheme = "jungle" | "space" | "ocean" | "party" | "calm";

const SCENE_GRADIENTS: Record<SceneTheme, string> = {
  jungle: "linear-gradient(180deg, #eafbea 0%, #cdf0c6 100%)",
  space: "linear-gradient(180deg, #e8e8ff 0%, #c9caf5 100%)",
  ocean: "linear-gradient(180deg, #e3f6fb 0%, #bfe9f5 100%)",
  party: "linear-gradient(180deg, #fff0f7 0%, #ffd7ea 100%)",
  calm: "linear-gradient(180deg, #fff8ec 0%, #fff8ec 100%)",
};

// Long enough for the child to actually look at a number or letter while
// it's being taught, not just register a quick flash.
const VISUAL_DISPLAY_MS = 3200;

// Ids here must match backend/src/geminiSession.ts's ACTIVITY_TOPICS keys
// exactly — tapping one sends { type: "select_activity", activity: id }
// over the voice socket to nudge the AI teacher's next response toward
// that topic (see selectActivity there for how, and
// teacherPersona.ts's "WHEN THE CHILD TAPS AN ACTIVITY BUTTON" for how the
// model is told to react). Icon-only by design — the child can't read yet.
const ACTIVITIES: { id: string; emoji: string; label: string }[] = [
  { id: "numbers", emoji: "🔢", label: "Numbers" },
  { id: "letters", emoji: "🔤", label: "Letters" },
  { id: "colors", emoji: "🎨", label: "Colors" },
  { id: "animals", emoji: "🐘", label: "Animals" },
  { id: "songs", emoji: "🎵", label: "Songs" },
];

export default function Home() {
  const [state, setState] = useState<State>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sceneTheme, setSceneTheme] = useState<SceneTheme>("calm");
  const [activeVisual, setActiveVisual] = useState<string | null>(null);
  const [visualKey, setVisualKey] = useState(0);

  const voiceSocketRef = useRef<VoiceSocket | null>(null);
  const micRef = useRef<MicStreamer | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const visualTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Guards against React Strict Mode's dev-only double-invocation of
    // effects: the first connection gets torn down almost immediately by
    // its own cleanup, but a straggling event from it could otherwise still
    // land on these state setters and race with the real connection.
    let disposed = false;

    playerRef.current = new AudioPlayer();
    const voiceSocket = new VoiceSocket();
    voiceSocketRef.current = voiceSocket;

    voiceSocket.connect(BACKEND_WS_URL, (event) => {
      if (disposed) return;
      switch (event.type) {
        case "ready":
          setState("ready");
          break;
        case "audio":
          playerRef.current?.enqueue(event.data);
          break;
        case "turn_complete":
          setState("ready");
          break;
        case "passive_listen":
          // The backend decided the child was talking to someone else in
          // the room, not the bot (see backend/src/audioProcessingEngine.ts)
          // — no audio was ever sent for that turn, so there's nothing to
          // play; just quietly go back to ready, exactly as if nothing
          // happened from the child's point of view.
          setState("ready");
          break;
        case "interrupted":
          // Gemini confirming the old response was cut off. The button
          // press that triggered this already reset local playback
          // pre-emptively; this catches anything that slipped in between
          // (e.g. a chunk from the old turn already in flight over the
          // network when we reset) so it never gets heard.
          playerRef.current?.reset();
          break;
        case "tool_call":
          // The AI teacher reacting on-screen mid-conversation — see
          // backend/src/geminiSession.ts's show_visual/set_scene tools and
          // teacherPersona.ts's "USING YOUR SCREEN TOOLS" section for when
          // it chooses to call these. content is an emoji, a number, or a
          // single English/Telugu letter — all rendered the same way.
          if (event.name === "show_visual" && typeof event.args.content === "string") {
            if (visualTimeoutRef.current) clearTimeout(visualTimeoutRef.current);
            setVisualKey((k) => k + 1);
            setActiveVisual(event.args.content as string);
            visualTimeoutRef.current = setTimeout(() => setActiveVisual(null), VISUAL_DISPLAY_MS);
          } else if (event.name === "set_scene" && typeof event.args.theme === "string") {
            const theme = event.args.theme as string;
            if (theme in SCENE_GRADIENTS) setSceneTheme(theme as SceneTheme);
          }
          break;
        case "reconnecting":
          // The connection to Gemini dropped and the backend is attempting
          // one automatic reconnect (see geminiSession.ts) — the browser's
          // own WebSocket to the backend is still open the whole time, so
          // there's nothing for the frontend to redo, just a brief wait.
          // If the child was mid-recording when it dropped, stop the mic
          // rather than let it keep streaming into a session that's being
          // torn down and reopened underneath it — they'll just press
          // again once back to "ready."
          micRef.current?.stop();
          setState("reconnecting");
          break;
        case "error":
          // A generic transport-level error can fire alongside/after a more
          // specific one the backend already relayed — whichever arrives
          // first should stick, not get clobbered by a vaguer one.
          setErrorMessage((prev) => prev ?? event.message);
          setState("error");
          break;
        case "closed":
          setErrorMessage((prev) => prev ?? "The voice server disconnected.");
          setState("error");
          break;
      }
    });

    return () => {
      disposed = true;
      voiceSocket.close();
      micRef.current?.stop();
      if (visualTimeoutRef.current) clearTimeout(visualTimeoutRef.current);
    };
  }, []);

  async function handlePressStart() {
    // Allow a press to interrupt a response in progress ("barge in"), not
    // just start a fresh turn from idle. Gemini's default activityHandling
    // (START_OF_ACTIVITY_INTERRUPTS — set explicitly in geminiSession.ts)
    // cuts off its current response as soon as it sees a new activityStart;
    // we just need to also stop whatever audio we're already playing
    // locally, since interrupting Gemini doesn't retroactively un-send the
    // chunks it already sent us.
    if (state !== "ready" && state !== "responding") return;
    if (state === "responding") playerRef.current?.reset();
    try {
      voiceSocketRef.current?.startTurn();
      const mic = new MicStreamer();
      micRef.current = mic;
      await mic.start((chunk) => voiceSocketRef.current?.sendAudioChunk(chunk));
      setState("listening");
    } catch {
      setErrorMessage("I couldn't hear the microphone. Please allow microphone access and try again.");
      setState("error");
    }
  }

  function handlePressEnd() {
    if (state !== "listening") return;
    micRef.current?.stop();
    voiceSocketRef.current?.endTurn();
    setState("responding");
  }

  function handleSelectActivity(activityId: string) {
    // Only while idle — picking a topic mid-turn would either interrupt
    // the child's own recording or land while Gemini's already mid-answer,
    // neither of which is what a tap on an icon should do.
    if (state !== "ready") return;
    voiceSocketRef.current?.selectActivity(activityId);
    setState("responding");
  }

  return (
    <main
      className="flex min-h-full flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center transition-[background] duration-[1200ms] ease-in-out"
      style={{ background: SCENE_GRADIENTS[sceneTheme] }}
    >
      {activeVisual && (
        <div
          key={visualKey}
          aria-hidden="true"
          // A single emoji/digit/letter reads well huge; a 2-digit number
          // (e.g. "12") needs a smaller size to stay comfortably on screen.
          className={`emoji-pop pointer-events-none fixed inset-0 z-10 flex items-center justify-center font-extrabold leading-none text-amber-800 ${
            Array.from(activeVisual).length <= 1 ? "text-[9rem]" : "text-[6rem]"
          }`}
        >
          {activeVisual}
        </div>
      )}

      <div>
        <p className="text-lg font-semibold text-amber-700">Toddler AI Voice Teacher</p>
        <p className="mt-1 text-sm text-[color:var(--foreground)]/60">English + Telugu</p>
      </div>

      <button
        type="button"
        disabled={state === "connecting" || state === "error" || state === "reconnecting"}
        onPointerDown={handlePressStart}
        onPointerUp={handlePressEnd}
        onPointerLeave={handlePressEnd}
        onPointerCancel={handlePressEnd}
        onContextMenu={(e) => e.preventDefault()}
        className={`flex h-64 w-64 select-none items-center justify-center rounded-full text-3xl font-extrabold text-white shadow-lg transition disabled:cursor-not-allowed disabled:opacity-70 ${STATE_COLOR[state]}`}
        style={{ touchAction: "none" }}
      >
        {state === "listening" ? "🎤" : state === "responding" ? "🧸" : "🎙️"}
      </button>

      <p className="text-xl font-semibold">{STATE_LABEL[state]}</p>

      {state === "error" && (
        <div className="max-w-sm">
          <p className="text-sm text-rose-600">{errorMessage}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-white hover:bg-amber-300"
          >
            Try again
          </button>
        </div>
      )}

      <div className="grid w-full max-w-xs grid-cols-3 gap-3">
        {ACTIVITIES.map((activity) => (
          <button
            key={activity.id}
            type="button"
            disabled={state !== "ready"}
            onClick={() => handleSelectActivity(activity.id)}
            className="flex flex-col items-center gap-1 rounded-2xl bg-white/70 px-2 py-3 text-xs font-semibold text-amber-800 shadow-sm transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-3xl leading-none">{activity.emoji}</span>
            {activity.label}
          </button>
        ))}
        <Link
          href="/puzzle"
          className="flex flex-col items-center gap-1 rounded-2xl bg-white/70 px-2 py-3 text-xs font-semibold text-amber-800 shadow-sm transition hover:bg-white"
        >
          <span className="text-3xl leading-none">🧩</span>
          Puzzle
        </Link>
      </div>

      <Link href="/recap" className="text-xs text-[color:var(--foreground)]/40 hover:underline">
        For parents: today&apos;s recap
      </Link>
    </main>
  );
}
