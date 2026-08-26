// A "thinking" filler played while waiting on Gemini's real response.
//
// This plays short pre-generated audio clips (backend/scripts/generate-
// filler-audio.ts, checked into frontend/public/filler/) spoken in the SAME
// Gemini voice the live conversation uses — not the browser's own
// text-to-speech, which sounds like a completely different person cutting
// in mid-conversation. Still instant (a local static file, no network round
// trip to Gemini needed at runtime), just recorded ahead of time instead of
// generated live.

const CLIP_IDS = ["hmm-1", "let-me-think", "ooh-good-question", "aalochistunnanu", "oka-nimisham"];

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let secondTimer: ReturnType<typeof setTimeout> | null = null;
let currentAudio: HTMLAudioElement | null = null;

function playRandomClip(): void {
  const id = CLIP_IDS[Math.floor(Math.random() * CLIP_IDS.length)];
  const audio = new Audio(`/filler/${id}.wav`);
  currentAudio = audio;
  audio.play().catch(() => {
    // Autoplay can be blocked before the first user gesture on some
    // browsers; harmless to skip a filler clip if so.
  });
}

/** Call right when a turn ends (mic released) and we're waiting on Gemini. */
export function startThinking(): void {
  stopThinking();
  // Only kick in if Gemini hasn't already started responding by ~1.2s in —
  // fast turns shouldn't get filler chatter they don't need.
  pendingTimer = setTimeout(() => {
    playRandomClip();
    // If it's STILL not back after a while longer, one more nudge so the
    // silence never stretches out unbroken.
    secondTimer = setTimeout(playRandomClip, 4000);
  }, 1200);
}

/** Call the instant real audio starts arriving (or the turn ends/errors). */
export function stopThinking(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  if (secondTimer) clearTimeout(secondTimer);
  pendingTimer = null;
  secondTimer = null;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}
