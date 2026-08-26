"use client";

import { useEffect, useRef, useState } from "react";

import { AudioPlayer, MicStreamer } from "@/lib/audio";
import { VoiceSocket } from "@/lib/voiceSocket";

const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:8081/voice";

type State = "connecting" | "ready" | "listening" | "responding" | "error";

const STATE_LABEL: Record<State, string> = {
  connecting: "Connecting…",
  ready: "Press and hold to talk!",
  listening: "I'm listening…",
  responding: "🧸",
  error: "Oops, something went wrong.",
};

const STATE_COLOR: Record<State, string> = {
  connecting: "bg-amber-300",
  ready: "bg-emerald-400 hover:bg-emerald-300 active:bg-emerald-500",
  listening: "bg-rose-400",
  responding: "bg-sky-400",
  error: "bg-zinc-300",
};

export default function Home() {
  const [state, setState] = useState<State>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const voiceSocketRef = useRef<VoiceSocket | null>(null);
  const micRef = useRef<MicStreamer | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);

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
    };
  }, []);

  async function handlePressStart() {
    if (state !== "ready") return;
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

  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center">
      <div>
        <p className="text-lg font-semibold text-amber-700">Toddler AI Voice Teacher</p>
        <p className="mt-1 text-sm text-[color:var(--foreground)]/60">English + Telugu</p>
      </div>

      <button
        type="button"
        disabled={state === "connecting" || state === "error"}
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
    </main>
  );
}
