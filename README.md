# Toddler AI Voice Teacher

A voice-first AI companion that teaches young children through spoken
interaction — no reading, no screen-tapping. The child speaks in English,
Telugu, or a natural mix of both, and the AI teacher listens and responds
entirely by voice, teaching alphabets, numbers, colors, animals, vocabulary,
songs, and short stories.

Full requirements are in `Toddler_AI_Voice_Teacher_Requirements.docx`
(project owner's copy). The short version:

- **Bilingual by design** — English + Telugu, with natural code-switching.
  Not a single-language app with a translation bolted on.
- **Voice-first** — every interaction is spoken; the child never has to read.
- **Low latency** — a toddler loses interest fast if the response is slow.
- **Education-first, not a general chatbot** — a defined teacher persona and
  safety rules, not an open-ended assistant.
- **Parent-controlled** — no personal information collected, safety
  boundaries baked into the AI's behavior.

**New here?** [**Read the project site →**](https://suryajogi.github.io/toddler-ai-voice-teacher/)
for a friendlier walkthrough of all of this, including exactly how to run
it on a Mac and use it from an iPhone or Android phone. The same content,
in plain Markdown, is in [`USAGE.md`](./USAGE.md).

## Status: Phase 1 — Voice Prototype

Per the requirements doc's own phased roadmap, this repo currently
implements **Phase 1 only**: a child presses one button, speaks in English
or Telugu, and gets an immediate spoken response. Later phases (structured
curriculum content, a learning-progress profile, a parent dashboard, a
dedicated device) come after this is proven out — see the requirements doc
for the full phase list.

## Architecture

**Gemini Live API is the entire voice+brain loop** — it's a natively
multimodal, bidirectional-audio model, so one API call handles listening,
understanding, and speaking together. There's no separate speech-to-text /
text-to-speech vendor.

```
Child's phone/tablet (Next.js, mic button)
        │  WebSocket (raw PCM16 audio + JSON control messages)
        ▼
Backend relay (Node.js + ws)  ── holds GEMINI_API_KEY, injects the
        │                         AI-teacher persona + safety rules
        ▼  @google/genai Live session
Gemini Live API (Google)
```

The backend exists specifically so the API key never reaches the browser,
and so the AI-teacher persona/safety rules (`backend/src/teacherPersona.ts`)
are enforced server-side, not something the client could bypass.

- `backend/` — Node.js + TypeScript. `src/server.ts` is the HTTP+WebSocket
  relay; `src/geminiSession.ts` wraps one Gemini Live session per connected
  child; `src/teacherPersona.ts` is the system instruction (persona + safety
  rules), taken directly from the requirements doc.
- `frontend/` — Next.js + TypeScript + Tailwind. One page
  (`app/page.tsx`): a big press-and-hold button, minimal/no text. Mic
  capture and audio playback (`lib/audio.ts`) use the Web Audio API
  directly — 16-bit PCM at 16kHz for input, 24kHz for Gemini's output.

## Running it locally

### 1. Get a Gemini API key

Get a key from [Google AI Studio](https://aistudio.google.com/apikey) for
quick prototyping (or Google Cloud / Vertex AI if you want enterprise
billing). Make sure the Live API is enabled for that key's project.

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
# edit .env and set GEMINI_API_KEY=<your key>
npm run dev
```

Runs on `http://localhost:8081`. `GET /health` reports whether a key is
configured. Without a key, the server still starts, but any client that
connects is told exactly that (rather than hanging or crashing) — the
`/voice` WebSocket relay is at `ws://localhost:8081/voice`.

### 3. Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local   # only needed if the backend isn't on localhost:8081
npm run dev
```

Open the URL it prints (typically `http://localhost:3000`, or the next free
port). Press and hold the button, speak, and let go to hear the response.

## Notes on the Gemini Live API surface

The Live API (model names, which API version exposes them, exact SDK
shapes) moves fast, and which models a given key/project can access varies
— **which live model your key can use is not something to guess**, it's
something to ask the API. If `GEMINI_LIVE_MODEL`'s default in
`backend/.env.example` doesn't work for your key (you'll see a `1008 model
not found` close reason in the backend log), run the `models.list()`
snippet in `.env.example` to get the real list for your account, and set
`GEMINI_LIVE_MODEL` to one of the returned names ending in
`bidiGenerateContent` support.

The default connects via `apiVersion: "v1alpha"` — some live-capable models
aren't exposed on the stable `v1beta` surface yet. `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`
is the voice-selection field; see
[the current Live API docs](https://ai.google.dev/gemini-api/docs/live) if
Google has changed the shape since.

This has been verified end-to-end against a real Gemini key: the backend
opens a live session and stays connected with no errors, and the frontend
reaches the green "ready" state and can open the mic. What hasn't been
machine-verified is a full spoken conversation (I can't generate real
toddler speech from a script) — that's the one thing to try yourself.
