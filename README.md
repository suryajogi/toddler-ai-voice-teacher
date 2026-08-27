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

## Beyond the base prototype: memory, screen reactions, recap

On top of the core voice loop, the backend now also:

- **Remembers past sessions.** Each session's transcript (captured via the
  Live API's built-in transcription) is summarized into topics/new
  words/struggling words and saved to `backend/data/learning-profile.json`.
  The next session's system instruction is built with that history folded
  in (`buildMemoryContext` in `backend/src/learningProfile.ts`), so the AI
  teacher builds on what's already been covered instead of starting cold
  every time.
- **Reacts on screen.** Two Gemini Live function-calling tools,
  `show_visual` and `set_scene` (declared in `backend/src/geminiSession.ts`),
  let the model shift the background theme or show something big on
  screen — an emoji, a number, or an English/Telugu letter — as an active
  teaching aid while it talks, not just a decorative flourish. Lands as
  `tool_call` WebSocket messages, handled in `frontend/app/page.tsx`.
- **Reconnects automatically.** Session resumption tokens
  (`sessionResumptionUpdate` in the Live API) let the backend silently
  retry once if the connection to Gemini drops mid-conversation, rather
  than the child hitting a hard error.
- **Gives parents a recap.** `GET /recap` on the backend returns recent
  session summaries; the frontend's `/recap` page (linked in small text at
  the bottom of the main screen) renders them.
- **Remembers durable facts about the child.** `backend/src/botMemoryEngine.ts`
  keeps a separate, structured SQLite store (`backend/data/bot_memory.db`,
  via Node's built-in `node:sqlite` — nothing extra to install) of
  per-child facts (favorite color, pets, family, hobbies) extracted from
  every turn, plus a vocabulary-pacing signal (`calculateVocabularyPacing`)
  that nudges the persona toward shorter, simpler sentences when the
  child's own utterances are running short. This is a different, more
  structured store than the session-summary JSON above — one tracks
  "what did we talk about lately," the other tracks "what do I know about
  this child."
- **Ignores side conversations.** `backend/src/audioProcessingEngine.ts`'s
  `detectSideConversation` is a cheap text heuristic (no added latency —
  see the file's module comment for why this isn't real audio speaker
  diarization) that recognizes when the child is talking to someone else
  in the room rather than the bot. When it fires, the bot's audio response
  for that turn is never played back (`passive_listen` over the
  WebSocket) — facts are still extracted in the background, but the child
  hears nothing, exactly as if the bot were quietly listening rather than
  interrupting a family conversation.
- **A text-only companion interface.** `POST /api/v1/bot/chat` wires the
  same filter + memory engine together over plain JSON (no microphone
  needed) — send `{"transcriptData": [{"speaker": "...", "text": "..."}]}`
  and get back `{"response": "...", "passiveListening": false, ...}`, or
  `{"response": null, "passiveListening": true, ...}` for a detected side
  conversation. Useful for testing the memory/filtering pipeline directly;
  the voice WebSocket remains the actual product experience.
- **Sings real songs and rhymes — including movie/show songs.** A third
  tool, `get_song_lyrics` (`backend/src/songLyricsEngine.ts`), recalls
  actual lyrics before singing/reciting them, rather than the model
  free-associating from memory mid-sentence — nursery rhymes, traditional
  Telugu paatalu, and movie/show songs (English or Telugu) are all fair
  game; being a movie song is not a reason to refuse. Getting this right
  took two real fixes, both documented in the file's header comment: (1)
  Google Search grounding actually made popular movie songs *less*
  available, not more — a grounded answer citing a real lyrics page
  triggers stricter copyright caution than the model just answering from
  its own trained knowledge, so grounding is deliberately not used; (2)
  prompt wording/ordering matters a lot — leading with any
  appropriateness framing (even "copyright is NOT a reason to refuse")
  measurably made the model over-refuse songs it otherwise knows fine.
  Unlike the instant screen tools, this one is genuinely asynchronous (a
  real lookup takes a moment), so the AI is told to keep talking naturally
  while it "remembers the song" rather than going silent.
- **An icon-based activity menu.** The home screen has picture buttons
  (Numbers/Letters/Colors/Animals/Songs, no reading required) that nudge
  the *already-open* conversation toward that topic via
  `GeminiVoiceSession.selectActivity()` — a `sendClientContent` text turn
  injected into the live session, not a reconnect, so the session's memory
  context and conversation-so-far are preserved. A sixth icon, 🧩 Puzzle,
  links to `/puzzle`: a standalone picture-matching memory game
  (`frontend/app/puzzle/page.tsx`) with no voice/backend dependency at
  all.

None of this needs extra setup beyond the existing `GEMINI_API_KEY` —
`backend/data/` is created automatically on first session and is
git-ignored (it's this specific child's data, not sample content).

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
  relay (plus the `/api/v1/bot/chat` text endpoint); `src/geminiSession.ts`
  wraps one Gemini Live session per connected child (transcription,
  screen-reaction + song-lookup tools, activity-menu text injection,
  reconnect-on-drop, side-conversation filtering); `src/teacherPersona.ts`
  is the system instruction (persona + safety rules), taken directly from
  the requirements doc, plus past-session memory; `src/learningProfile.ts`
  and `src/sessionSummarizer.ts` are the session-summary/recap persistence
  layer; `src/botMemoryEngine.ts` (SQLite) and
  `src/audioProcessingEngine.ts` are the structured long-term memory +
  side-conversation filter; `src/songLyricsEngine.ts` is the
  search-grounded lyrics lookup, all described above.
- `frontend/` — Next.js + TypeScript + Tailwind. Main page (`app/page.tsx`):
  a big press-and-hold button plus a small icon-based activity menu,
  minimal/no text otherwise. Mic capture and audio playback (`lib/audio.ts`)
  use the Web Audio API directly — 16-bit PCM at 16kHz for input, 24kHz for
  Gemini's output. `app/puzzle/page.tsx` is the standalone matching game;
  `app/recap/page.tsx` is the parent-facing session recap.

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
