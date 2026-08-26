// A "thinking" filler, spoken locally by the browser's own speech synthesis
// (not Gemini) so it's instant regardless of how long Gemini's real
// response takes — the whole point is to fill exactly the gap that a slow
// network/model turn creates. Language-agnostic interjections on purpose:
// the child could be mid-Telugu or mid-English, and every platform's
// built-in speechSynthesis reliably has an English voice, but Telugu voice
// availability varies a lot by device/browser — this only needs to sound
// like a natural "hmm", not deliver real content.

const PHRASES = ["Hmm...", "Ooh, let me think...", "Mmm, good one...", "Okay..."];

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let secondTimer: ReturnType<typeof setTimeout> | null = null;

function speak(phrase: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(phrase);
  utterance.rate = 0.95;
  utterance.pitch = 1.15; // slightly higher/friendlier, matching the app's playful tone
  window.speechSynthesis.speak(utterance);
}

/** Call right when a turn ends (mic released) and we're waiting on Gemini. */
export function startThinking(): void {
  stopThinking();
  // Only kick in if Gemini hasn't already started responding by ~1.2s in —
  // fast turns shouldn't get filler chatter they don't need.
  pendingTimer = setTimeout(() => {
    speak(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
    // If it's STILL not back after a while longer, one more nudge so the
    // silence never stretches out unbroken.
    secondTimer = setTimeout(() => {
      speak(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
    }, 4000);
  }, 1200);
}

/** Call the instant real audio starts arriving (or the turn ends/errors). */
export function stopThinking(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  if (secondTimer) clearTimeout(secondTimer);
  pendingTimer = null;
  secondTimer = null;
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}
