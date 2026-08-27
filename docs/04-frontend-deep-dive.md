---
layout: default
title: Frontend Deep Dive
---

# Frontend Deep Dive

[← Backend Deep Dive](03-backend-deep-dive.html)

The main child-facing screen is still one page, but the app now has two
more: a parent-facing recap and a standalone puzzle game. This section
covers `frontend/app/page.tsx` (the button, the state machine, and the new
activity menu), `lib/voiceSocket.ts` (the WebSocket client), `lib/audio.ts`
(microphone capture and audio playback), `public/pcm-recorder-worklet.js`
(the lowest-level audio conversion), `app/recap/page.tsx`, and
`app/puzzle/page.tsx`. `app/layout.tsx` is only a few lines — it sets the
page title/font and wraps everything in the standard Next.js page shell —
and isn't detailed further here.

## `lib/voiceSocket.ts` — a thin wrapper around the browser's WebSocket

```typescript
export type VoiceEvent =
  | { type: "ready" }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "closed" }
  | { type: "error"; message: string }
  | { type: "audio"; data: ArrayBuffer }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "reconnecting" }
  | { type: "passive_listen" };

export class VoiceSocket {
  connect(url: string, onEvent: (event: VoiceEvent) => void): void {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) { onEvent({ type: "audio", data: event.data }); return; }
      const parsed = JSON.parse(event.data);
      onEvent(parsed as VoiceEvent);
    };
    ...
  }
  startTurn(): void { this.ws?.send(JSON.stringify({ type: "start_turn" })); }
  sendAudioChunk(pcm16: ArrayBuffer): void { this.ws?.send(pcm16); }
  endTurn(): void { this.ws?.send(JSON.stringify({ type: "end_turn" })); }
  selectActivity(activityId: string): void {
    this.ws?.send(JSON.stringify({ type: "select_activity", activity: activityId }));
  }
}
```

`VoiceEvent` is a TypeScript **union type** — "a `VoiceEvent` is *one of*
these nine exact shapes" (recognizable by its `type` field, a pattern
called a "discriminated union"). This is the frontend's mirror of exactly
the message shapes `backend/src/server.ts` sends — three of these
(`tool_call`, `reconnecting`, `passive_listen`) didn't exist in the
original version of this file, and were added one at a time as
`backend/src/geminiSession.ts` grew new callbacks (see [Backend Deep
Dive](03-backend-deep-dive.html)). `WebSocket` here is a built-in browser
API — no library needed to open one. The rest of the class is a thin
"translate a JS/browser concept into the app's own vocabulary" layer:
callers of `VoiceSocket` never touch a raw `WebSocket` or write `.send()`
calls themselves — they call methods like `startTurn()` or
`selectActivity()` and receive typed `VoiceEvent`s back.

## `lib/audio.ts` — turning the microphone into data, and data into sound

### `MicStreamer` — capturing the microphone

```typescript
async start(onChunk: (pcm16: ArrayBuffer) => void): Promise<void> {
  this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  this.context = new AudioContext({ sampleRate: 16000 });
  await this.context.audioWorklet.addModule("/pcm-recorder-worklet.js");
  const source = this.context.createMediaStreamSource(this.stream);
  this.workletNode = new AudioWorkletNode(this.context, "pcm-recorder-processor");
  this.workletNode.port.onmessage = (event) => onChunk(event.data);
  source.connect(this.workletNode);
}
```

`navigator.mediaDevices.getUserMedia({ audio: true })` is the browser API
that requests microphone access — this is the exact call that triggers
the "Allow microphone access?" permission prompt. `AudioContext` is the
browser's entry point into the **Web Audio API**, a whole subsystem for
processing sound; creating it with `sampleRate: 16000` requests the
browser handle any necessary conversion from the microphone's native
recording rate down to the 16kHz Gemini Live requires, so this code
doesn't have to implement resampling itself.

An **AudioWorklet** is a small piece of code (here,
`pcm-recorder-worklet.js`, covered below) that runs in its own dedicated
real-time audio-processing thread, separate from the browser's regular
JavaScript — necessary because audio must be processed with very tight,
consistent timing, which ordinary JavaScript running alongside everything
else on the page can't reliably guarantee. `source.connect(this.workletNode)`
wires the microphone's raw signal into that worklet; deliberately **not**
also connecting to `context.destination` (the speakers), since you don't
want to hear your own voice played back to you while recording.

### `AudioPlayer` — gapless streamed playback

```typescript
enqueue(pcm16: ArrayBuffer): void {
  const int16 = new Int16Array(pcm16);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }
  const buffer = context.createBuffer(1, float32.length, 24000);
  buffer.copyToChannel(float32, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const startAt = Math.max(this.nextStartTime, context.currentTime);
  source.start(startAt);
  this.nextStartTime = startAt + buffer.duration;
}
```

Gemini's spoken response doesn't arrive as one complete audio file — it
streams in as a sequence of small chunks, as it's generated. Each
`enqueue()` call handles exactly one chunk: it converts the raw 16-bit
integer samples (`Int16Array`, range roughly -32768 to 32767) into the
`-1.0` to `1.0` floating-point range the Web Audio API's `AudioBuffer`
expects, wraps that into a playable buffer, and — this is the important
part — **schedules it to start exactly when the previous chunk ends**
(`this.nextStartTime`), rather than simply playing it immediately. Every
chunk arrives from the network slightly separated in time; without this
scheduling, you'd hear small gaps or clicks between chunks instead of one
continuous voice. `reset()` (called on interruption/barge-in — see
[Architecture Overview](02-architecture-overview.html)) simply closes and
discards the whole audio context, which immediately stops anything
scheduled or currently playing.

## `public/pcm-recorder-worklet.js` — raw samples to 16-bit integers

```javascript
class PcmRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-recorder-processor", PcmRecorderProcessor);
```

This is the exact reverse conversion of `AudioPlayer.enqueue()` above:
the Web Audio API hands this `process()` method small batches of raw
microphone samples as floating-point numbers (`-1.0` to `1.0`), and this
code converts each one back into a 16-bit integer, matching the format
Gemini Live's input requires. `Math.max(-1, Math.min(1, ...))` **clamps**
the value — guards against a sample that's technically gone slightly
outside the expected range from ever overflowing when multiplied up.
`this.port.postMessage(...)` sends the finished chunk out of the
dedicated audio-processing thread and back to regular JavaScript (where
`MicStreamer`'s `onmessage` handler, above, receives it) — this
hand-off between the two threads is the entire reason this file has to
exist as a separate "worklet" module rather than being ordinary code
inside `audio.ts`.

## `app/page.tsx` — the button, the activity menu, and the state machine

The main component now holds several pieces of state, but the core is
still one state machine:

```typescript
type State = "connecting" | "ready" | "listening" | "responding" | "reconnecting" | "error";
```

Two states were added since the original version: `"reconnecting"`
(shown while `geminiSession.ts` retries a dropped connection — see
[Backend Deep Dive](03-backend-deep-dive.html)) and, separately, the
`"passive_listen"` *event* is handled without a dedicated state at all —
it just quietly returns to `"ready"`, since no audio was ever sent for
that turn and nothing visibly happened from the child's point of view.
Every possible UI treatment (`STATE_LABEL`, `STATE_COLOR`) is still
defined once per state as a lookup table, rather than scattered `if`
statements through the render code.

Reading the flow in order:

1. On page load, `useEffect` runs once: creates an `AudioPlayer`, creates
   a `VoiceSocket`, and calls `.connect(...)`, wiring each possible
   `VoiceEvent` to a state transition. `state` starts as `"connecting"`
   and the button is disabled until this resolves.
2. **Pressing the button** (`onPointerDown`) calls `handlePressStart()`:
   sends `startTurn()`, starts a `MicStreamer`, and sets `state` to
   `"listening"` — resetting audio playback first if Gemini was
   mid-answer (barge-in, see [Architecture
   Overview](02-architecture-overview.html)).
3. **Releasing the button** calls `handlePressEnd()`: stops the mic, sends
   `endTurn()`, sets `state` to `"responding"`.
4. Audio chunks (`case "audio":`) go straight to
   `playerRef.current?.enqueue(event.data)`.
5. `case "turn_complete":` and `case "passive_listen":` both return to
   `"ready"` — the only difference is that the second one never played
   any audio in between.
6. `case "reconnecting":` stops the mic (in case the child was mid-press
   when the connection dropped) and shows the reconnecting state;
   `case "ready":` (sent again once reconnected) brings it back — the
   *same* event type used for the very first connection and for a
   successful reconnect, since from the frontend's point of view they're
   identical: "the backend is ready for a turn."

### Reacting on screen: the `tool_call` event

```typescript
case "tool_call":
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
```

`show_visual` and `set_scene` (see [Backend Deep
Dive](03-backend-deep-dive.html) for the tools themselves) both arrive as
this one event shape, distinguished by `event.name`. `show_visual`'s
content — an emoji, a number, or a letter — is shown via a `key={visualKey}`
trick: incrementing a counter and using it as React's `key` prop forces
React to treat each occurrence as a brand-new element, which restarts the
CSS pop-in animation even if the *same* content (e.g. the same emoji
twice in a row) is shown back to back — without a changing key, React
would just leave the existing element in place and the animation
wouldn't replay. The displayed size adapts to content length
(`Array.from(activeVisual).length <= 1 ? "text-[9rem]" : "text-[6rem]"`)
so a two-digit number doesn't overflow the way a single emoji or letter
wouldn't.

### The activity menu: steering the conversation without reconnecting

```typescript
const ACTIVITIES = [
  { id: "numbers", emoji: "🔢", label: "Numbers" },
  { id: "letters", emoji: "🔤", label: "Letters" },
  { id: "colors", emoji: "🎨", label: "Colors" },
  { id: "animals", emoji: "🐘", label: "Animals" },
  { id: "songs", emoji: "🎵", label: "Songs" },
];

function handleSelectActivity(activityId: string) {
  if (state !== "ready") return;
  voiceSocketRef.current?.selectActivity(activityId);
  setState("responding");
}
```

These render as icon-only buttons (plus a sixth, a `<Link>` to `/puzzle`)
— no text the child would need to read to use them, consistent with this
app's "voice-first, no reading required" design. Tapping one is only
allowed while `state === "ready"`: mid-recording or mid-answer, a tap
would either interrupt the child's own turn or land while Gemini's
already speaking, neither of which is what an icon tap should do.
`setState("responding")` immediately after sending is **optimistic** —
the frontend assumes a response is coming before it's confirmed, purely
so the button visually disables itself right away; the real state
transition to `"ready"` still comes from the backend's own
`turn_complete` once Gemini actually finishes.

## `app/recap/page.tsx` — the parent-facing session history

A single `useEffect` fetches `GET /recap` from the backend (deriving the
HTTP URL from the same `NEXT_PUBLIC_BACKEND_WS_URL` env var the voice
socket uses, just swapping `ws://` for `http://`, so there's only one
address to configure) and renders the returned session list — each
session's `summaryForParent` plus colored "chip" tags for its topics, new
words, and still-tricky words. There's no loading spinner library or
fancy state machine here: just `sessions: SessionRecord[] | null` (`null`
while loading, `[]` once loaded with nothing yet, populated once there's
real history) and a plain `error: string | null` for a failed fetch — the
minimum state needed to show the three real outcomes (loading, empty,
here's the data) correctly.

## `app/puzzle/page.tsx` — a standalone matching-pairs game

This page is deliberately independent of everything else in the app — no
`VoiceSocket`, no `fetch`, no Gemini involvement at all. It's a classic
memory/concentration game: flip two cards, and if they match, they stay
revealed; if not, they flip back after a short pause.

```typescript
function newDeck(): Card[] {
  const chosenEmoji = shuffled(EMOJI_POOL).slice(0, PAIR_COUNT);
  const pairedAndShuffled = shuffled([...chosenEmoji, ...chosenEmoji]);
  return pairedAndShuffled.map((emoji, i) => ({ id: i, emoji, flipped: false, matched: false }));
}
```

Building the deck is two `shuffled()` calls: pick `PAIR_COUNT` random
emoji out of a larger pool (so replaying gives a different set), then
duplicate each one and shuffle the *combined* list of pairs (so matching
positions aren't predictable). `shuffled()` itself is a standard
Fisher–Yates shuffle — walk the array backward, and at each position swap
in a random earlier element — a well-known, unbiased way to randomly
reorder a list (a naive "sort by `Math.random()`" approach, which you may
see elsewhere, is a common but subtly biased alternative worth knowing to
avoid).

```typescript
function handleFlip(id: number) {
  if (busy || won || flippedIds.length === 2) return;
  const tapped = cards.find((c) => c.id === id);
  if (!tapped || tapped.flipped || tapped.matched) return;
  // ... flip it, and if this is the second card flipped this turn,
  // compare emoji and either mark both matched or (after a timeout) flip
  // both back
}
```

`busy` is `true` for the brief window where a *non-matching* pair is
shown face-up before flipping back — it exists specifically to block a
third tap from interfering while that timeout is pending. This is a
common shape for any "two-step selection with a timed reveal" UI: a
boolean state purely to gate input during an in-between moment that
doesn't correspond to any of the "real" states of the game.

---
[← Backend Deep Dive](03-backend-deep-dive.html) · [Next: Glossary →](05-glossary.html)
