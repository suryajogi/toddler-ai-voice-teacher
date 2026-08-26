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

The Live API (model names, exact SDK shapes) moves fast. This was built
against `@google/genai`'s documented `ai.live` surface and its own example
code (`gemini-live-2.5-flash-preview` as the model,
`speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` for voice
selection). If Google has renamed things since, check
[the current Live API docs](https://ai.google.dev/gemini-api/docs/live) —
`GEMINI_LIVE_MODEL` and `GEMINI_LIVE_VOICE` in `backend/.env` are overridable
without touching code.

This has **not** been tested against a real Gemini key yet (no key was
available while building it) — the relay, error handling, and UI have all
been verified against a running backend with no/invalid credentials, which
exercises every code path except an actual successful voice round-trip.
That's the first thing to check once you have a real key.
