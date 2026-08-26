---
layout: default
title: Backend Deep Dive
---

# Backend Deep Dive

[← Architecture Overview](02-architecture-overview.html)

The entire backend is three files in `backend/src/`. Small by design —
Gemini Live absorbs almost all of the traditional complexity (speech
recognition, response generation, speech synthesis), so what's left for
this backend to do is genuinely just: hold the connection, hold the API
key, and relay messages.

## `server.ts` — the HTTP + WebSocket relay

```typescript
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", geminiConfigured: !!GEMINI_API_KEY }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/voice" });
```

Two servers share one port here: a plain HTTP server (just for `GET
/health` — a quick way to check the backend is up and whether an API key
is configured, without opening a full voice session) and a **WebSocket
server**, attached to the same underlying HTTP server, listening
specifically at the `/voice` path. `!!GEMINI_API_KEY` is a common
JavaScript idiom — `!` twice in a row converts any value to a plain
`true`/`false` ("is this thing present/truthy at all"), here answering
"is an API key configured," without leaking the key itself in the
response.

```typescript
wss.on("connection", (ws) => {
  if (!GEMINI_API_KEY) {
    sendJson(ws, { type: "error", message: "GEMINI_API_KEY is not configured..." });
    ws.close();
    return;
  }

  const geminiSession = new GeminiVoiceSession(GEMINI_API_KEY, {
    onAudio: (pcm) => { if (ws.readyState === WebSocket.OPEN) ws.send(pcm); },
    onTurnComplete: () => sendJson(ws, { type: "turn_complete" }),
    onInterrupted: () => sendJson(ws, { type: "interrupted" }),
    onError: (message) => { sendJson(ws, { type: "error", message }); ws.close(); },
    onClose: () => { sendJson(ws, { type: "closed" }); ws.close(); },
  });

  geminiSession.ready()
    .then(() => sendJson(ws, { type: "ready" }))
    .catch((err) => { ... sendJson(ws, { type: "error", ... }); ws.close(); });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      geminiSession.sendAudioChunk(Buffer.from(data as Buffer));
      return;
    }
    const control = JSON.parse(data.toString());
    if (control.type === "start_turn") geminiSession.startTurn();
    else if (control.type === "end_turn") geminiSession.endTurn();
  });

  ws.on("close", () => geminiSession.close());
});
```

`wss.on("connection", (ws) => { ... })` runs once **per browser tab** that
connects — `ws` here is that specific browser's own WebSocket connection.
Everything inside creates and wires up **one dedicated `GeminiVoiceSession`
per connection** (from `geminiSession.ts`, covered next): every visitor
gets their own private, independent Gemini Live session — there's no
shared/pooled session between different children using the app at once.

Notice the shape: `GeminiVoiceSession` is handed a set of **callback
functions** (`onAudio`, `onTurnComplete`, etc.) at creation time — this is
the same idea introduced in [Your Toolbox](01-your-toolbox.html)'s
`GeminiSessionCallbacks` interface. `server.ts` doesn't know or care *how*
Gemini decides a turn is complete; it just supplies "when that happens,
here's what to do" (`sendJson(ws, { type: "turn_complete" })`) and lets
`geminiSession.ts` call it at the right moment. This is a very common
pattern for wiring together two pieces of code that need to react to each
other's events without being tightly coupled together.

The `ws.on("message", ...)` handler is the browser → backend direction:
binary data is audio, forwarded straight to Gemini via
`sendAudioChunk`; anything else is parsed as JSON and checked for
`start_turn`/`end_turn`, calling the matching method on the session. If
parsing fails (`try`/`catch`, not shown above in full), it's silently
ignored rather than crashing the connection — a defensive habit worth
noting: never let one malformed message from a client take down the
whole session.

## `geminiSession.ts` — one wrapped Gemini Live session

This file's entire job is translating between "what `server.ts` needs"
(simple method calls: `startTurn()`, `sendAudioChunk(buffer)`,
`endTurn()`, `close()`) and "what the actual `@google/genai` library's
Gemini Live API expects" — isolating every Gemini-specific detail into
one file, so if Google changes that API's shape later, only this one file
needs to change.

```typescript
const ai = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });

this.connecting = ai.live.connect({
  model: MODEL,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: TEACHER_SYSTEM_INSTRUCTION,
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
    realtimeInputConfig: {
      automaticActivityDetection: { disabled: true },
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
    },
  },
  callbacks: {
    onmessage: (message) => { ... },
    onerror: (event) => callbacks.onError(event.message ?? "..."),
    onclose: (event) => callbacks.onClose(),
  },
}).then((session) => { this.session = session; });
```

Reading the config options, each maps to a concept already introduced in
[Architecture Overview](02-architecture-overview.html):

- `responseModalities: [Modality.AUDIO]` — "respond with spoken audio," as
  opposed to text.
- `systemInstruction: TEACHER_SYSTEM_INSTRUCTION` — the entire teacher
  persona/safety block from `teacherPersona.ts` (below), set once, for the
  whole session.
- `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` — which of
  Gemini's built-in voices to speak with (configurable via the
  `GEMINI_LIVE_VOICE` environment variable, defaulting to `"Aoede"`).
- `automaticActivityDetection: { disabled: true }` and
  `activityHandling: START_OF_ACTIVITY_INTERRUPTS` — the push-to-talk and
  barge-in behavior explained in [Architecture
  Overview](02-architecture-overview.html), made explicit here in code.
- No `languageCode` is set, **on purpose** (see the code comment) — since
  the child freely mixes English and Telugu, pinning the session to one
  language would work against exactly the behavior this app wants.

```typescript
onmessage: (message: LiveServerMessage) => {
  if (message.serverContent?.interrupted) {
    this.suppressNextTurnComplete = true;
    callbacks.onInterrupted();
  }
  const audioPart = message.serverContent?.modelTurn?.parts?.find((p) => p.inlineData?.data);
  if (audioPart?.inlineData?.data) {
    callbacks.onAudio(Buffer.from(audioPart.inlineData.data, "base64"));
  }
  if (message.serverContent?.turnComplete) {
    if (this.suppressNextTurnComplete) this.suppressNextTurnComplete = false;
    else callbacks.onTurnComplete();
  }
},
```

Every message Gemini sends back arrives through this one `onmessage`
callback, and can carry several different pieces of information at once
(hence the sequence of independent `if` checks rather than a single
either/or). The trickiest piece of logic in this entire codebase is
`suppressNextTurnComplete`, and it exists to fix a subtle real bug: when
you interrupt Gemini mid-response (barge-in), Gemini still sends a
trailing "turn complete" event afterward for the *old, already-abandoned*
turn — not for whatever the child just asked instead. Without this flag,
that stray, delayed "turn complete" would arrive and incorrectly flip the
frontend's state back to "ready" partway through the *new* answer still
being spoken. Setting `suppressNextTurnComplete = true` the moment an
interruption happens means "the very next `turnComplete` I see is that
stray leftover — swallow it once, then go back to normal." This is a good
example of a bug that's invisible from reading the "happy path" code
alone and only shows up from testing the actual interrupt behavior.

```typescript
sendAudioChunk(pcm16Mono16k: Buffer): void {
  this.session?.sendRealtimeInput({
    audio: { data: pcm16Mono16k.toString("base64"), mimeType: "audio/pcm;rate=16000" },
  });
}
```

`?.` ("optional chaining") means "call this only if `this.session` isn't
null" — a safety check for the brief window before the Gemini connection
has finished opening. Audio bytes are converted to **base64** (a way of
representing arbitrary binary data as plain text) before sending, because
the underlying transport for this particular call expects a text-safe
string, not raw binary — the same conversion happens in reverse
(`Buffer.from(..., "base64")`) wherever this project needs to turn a
base64 string back into raw audio bytes.

## `teacherPersona.ts` — the entire AI behavior, in one prompt

This file is pure text — a single large **system instruction** string
handed to Gemini once per session (see `geminiSession.ts` above) — not
code, in the sense that there's no logic to execute here, only
instructions written in plain English for the AI model to follow. It's
the single source of truth for how the AI teacher behaves, organized into
clear sections worth knowing about even without reading the full text:

- **How every response should open** — the AI is instructed to
  acknowledge what the child said *and* answer it in one continuous
  breath, never a separate "got it!" message followed by a pause before
  the real answer — because a toddler will lose the thread during any
  gap.
- **Language / code-switching** — explicit instructions and worked
  examples for mixing English and Telugu naturally within a single
  sentence (the way real bilingual families actually speak), rather than
  translating the same word back-to-back in both languages.
- **Understanding toddler speech** — instructions to expect fragments,
  repeated words, and unclear pronunciation as completely normal, and to
  infer meaning from context rather than asking the child to "speak
  properly."
- **Teaching, not just answering** — "recasting": when a child says a
  word imperfectly, the AI models the correct version back warmly, without
  saying "no" or "wrong," then gently (never insistently) invites them to
  try repeating it.
- **Safety** — never age-inappropriate content, never asks for personal
  information (name, address, phone, school, photos), defers to a parent
  for anything needing adult judgment, and stays strictly in the
  teacher/educator role even if asked to do something else.

Because this instruction is just a string, tuning the AI's behavior is
purely an editing task on this one file — no other code anywhere needs to
change to adjust tone, teaching style, or safety rules.

---
[← Architecture Overview](02-architecture-overview.html) · [Next: Frontend Deep Dive →](04-frontend-deep-dive.html)
