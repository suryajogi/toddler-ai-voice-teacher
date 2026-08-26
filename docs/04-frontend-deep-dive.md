---
layout: default
title: Frontend Deep Dive
---

# Frontend Deep Dive

[← Backend Deep Dive](03-backend-deep-dive.html)

The entire user-facing app is one page. This section covers
`frontend/app/page.tsx` (the button and its states), `lib/voiceSocket.ts`
(the WebSocket client), `lib/audio.ts` (microphone capture and audio
playback), and `public/pcm-recorder-worklet.js` (the lowest-level audio
conversion). `app/layout.tsx` is only a few lines — it sets the page
title/font and wraps everything in the standard Next.js page shell — and
isn't detailed further here.

## `lib/voiceSocket.ts` — a thin wrapper around the browser's WebSocket

```typescript
export type VoiceEvent =
  | { type: "ready" }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "closed" }
  | { type: "error"; message: string }
  | { type: "audio"; data: ArrayBuffer };

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
}
```

`VoiceEvent` is a TypeScript **union type** — "a `VoiceEvent` is *one of*
these six exact shapes" (recognizable by its `type` field, a pattern
called a "discriminated union"). This is the frontend's mirror of exactly
the message shapes `backend/src/server.ts` sends, the same
"types on both sides must be kept in sync by hand" situation described
for `ai-agent-demo`'s `lib/api.ts` in that project's own frontend guide.
`WebSocket` here is a built-in browser API — no library needed to open
one; `ws.binaryType = "arraybuffer"` just tells the browser "give me
binary frames as an `ArrayBuffer`" (a raw block of bytes) rather than
some other binary representation. The rest of the class is a thin
"translate a JS/browser concept into the app's own vocabulary" layer:
callers of `VoiceSocket` never touch a raw `WebSocket` or write `.send()`
calls themselves — they call `startTurn()`/`sendAudioChunk()`/`endTurn()`
and receive typed `VoiceEvent`s, matching one-to-one with the protocol
described in [Architecture Overview](02-architecture-overview.html).

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

## `app/page.tsx` — the button, and the state machine tying it together

The whole visible app is one component holding a single piece of state:

```typescript
type State = "connecting" | "ready" | "listening" | "responding" | "error";
```

This is a TypeScript **union of exact string values** — `state` can only
ever be one of these five, and every possible UI treatment (`STATE_LABEL`,
`STATE_COLOR`) is defined once per state as a lookup table, rather than as
scattered `if` statements throughout the render code. Reading the flow in
order:

1. On page load, `useEffect` runs once: creates an `AudioPlayer`, creates
   a `VoiceSocket`, and calls `.connect(...)`, wiring each possible
   `VoiceEvent` to a state transition — e.g. `case "ready": setState("ready")`.
   `state` starts as `"connecting"` and the button is disabled until this
   resolves.
2. **Pressing the button** (`onPointerDown`, which fires for mouse,
   touch, and stylus input alike — one handler covers every input
   device) calls `handlePressStart()`: sends `startTurn()` over the
   socket, starts a `MicStreamer`, wires its captured chunks straight to
   `voiceSocket.sendAudioChunk(...)`, and sets `state` to `"listening"`.
   If the state was `"responding"` (the AI mid-answer), it resets audio
   playback first — this is the barge-in behavior from [Architecture
   Overview](02-architecture-overview.html), triggered directly by this
   button press.
3. **Releasing the button** (`onPointerUp`/`onPointerLeave`/
   `onPointerCancel` — all three are wired to the same handler, since a
   finger sliding off the button on a touchscreen should end the turn
   exactly like a normal release) calls `handlePressEnd()`: stops the mic,
   sends `endTurn()`, and sets `state` to `"responding"`.
4. Audio chunks arriving from the backend (`case "audio":`) are simply
   handed to `playerRef.current?.enqueue(event.data)` — the component
   itself does no audio work directly; it just routes events to the
   `AudioPlayer`/`MicStreamer` instances doing the real work.
5. `case "turn_complete":` sets `state` back to `"ready"`, closing the
   loop.

The `disposed` flag inside the `useEffect` guards against a React-specific
quirk in development mode (Strict Mode intentionally runs setup/cleanup
twice, to help catch bugs) — without it, a stray event from an
already-torn-down first connection could otherwise land on state setters
and race against the real, second connection. It has no effect on the
production build's actual behavior; it only matters during local
development.

---
[← Backend Deep Dive](03-backend-deep-dive.html) · [Next: Glossary →](05-glossary.html)
