---
layout: default
title: Backend Deep Dive
---

# Backend Deep Dive

[← Architecture Overview](02-architecture-overview.html)

The backend started as three small files. It's grown since — session
memory, a long-term memory database, a side-conversation filter, and a
song-lyrics lookup all live here too now — but the core idea hasn't
changed: Gemini Live absorbs almost all of the traditional complexity
(speech recognition, response generation, speech synthesis), so most of
what this backend does is hold the connection, enrich what Gemini knows
about this specific child, and relay messages.

## `server.ts` — the HTTP + WebSocket relay

```typescript
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") { /* ... */ }
  if (req.url === "/recap") { /* returns recent session summaries as JSON */ }
  if (req.url === "/api/v1/bot/chat" && req.method === "POST") { /* text-only companion API */ }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/voice" });
```

Two servers share one port: a plain HTTP server (three JSON endpoints —
`/health`, the parent-facing `/recap`, and `/api/v1/bot/chat`, covered in
their own sections below) and a **WebSocket server** attached to the same
underlying HTTP server, listening at `/voice`. `!!GEMINI_API_KEY` is a
common JavaScript idiom — `!` twice converts any value to a plain
`true`/`false`, here answering "is an API key configured," without
leaking the key itself.

```typescript
wss.on("connection", (ws) => {
  const childId = ensureDefaultChildProfile();
  const sessionId = randomUUID();
  const profile = loadProfile();
  const childContext = fetchChildContext(childId);
  const memoryContext = [buildMemoryContext(profile), buildChildContextPrompt(childContext)]
    .filter(Boolean)
    .join("\n\n");

  const geminiSession = new GeminiVoiceSession(
    GEMINI_API_KEY,
    {
      onAudio: (pcm) => { if (ws.readyState === WebSocket.OPEN) ws.send(pcm); },
      onTurnComplete: () => sendJson(ws, { type: "turn_complete" }),
      onInterrupted: () => sendJson(ws, { type: "interrupted" }),
      onToolCall: (name, args) => sendJson(ws, { type: "tool_call", name, args }),
      onReconnecting: () => sendJson(ws, { type: "reconnecting" }),
      onReconnected: () => sendJson(ws, { type: "ready" }),
      onPassiveListen: () => sendJson(ws, { type: "passive_listen" }),
      onError: (message) => { sendJson(ws, { type: "error", message }); ws.close(); },
      onClose: () => { sendJson(ws, { type: "closed" }); ws.close(); },
    },
    childId,
    sessionId,
    memoryContext
  );

  ws.on("message", (data, isBinary) => {
    if (isBinary) { geminiSession.sendAudioChunk(Buffer.from(data)); return; }
    const control = JSON.parse(data.toString());
    if (control.type === "start_turn") geminiSession.startTurn();
    else if (control.type === "end_turn") geminiSession.endTurn();
    else if (control.type === "select_activity") geminiSession.selectActivity(control.activity);
  });

  ws.on("close", () => {
    geminiSession.close();
    const transcript = geminiSession.getTranscript();
    if (transcript.trim()) {
      summarizeSession(GEMINI_API_KEY, transcript).then((summary) => {
        if (summary) recordSession(loadProfile(), summary, sessionStartedAt, new Date());
      });
    }
  });
});
```

`wss.on("connection", (ws) => { ... })` runs once **per browser tab** that
connects. Before creating the session, `server.ts` gathers everything
worth telling the AI teacher about *this specific child* — recent session
topics (`learningProfile.ts`) and durable facts (`botMemoryEngine.ts`) —
and combines them into one `memoryContext` string handed to
`GeminiVoiceSession`'s constructor, which folds it into the system
instruction (see `teacherPersona.ts` below). This all happens **once, at
connection time** — an already-open Live session's persona can't be
changed mid-conversation, which is why memory only ever affects the
*next* session, never the current one already in progress.

`GeminiVoiceSession` is handed a set of **callback functions** at creation
time — `server.ts` doesn't know or care *how* Gemini decides a turn is
complete, or a tool was called, or the connection needs to reconnect; it
just supplies "when that happens, here's what to do" and lets
`geminiSession.ts` call the right one at the right moment. Each callback
maps to one WebSocket message type the frontend understands (see
[Frontend Deep Dive](04-frontend-deep-dive.html)):

| Callback | Sent to browser as | Why |
|---|---|---|
| `onAudio` | binary audio frame | Gemini's spoken response, streamed |
| `onTurnComplete` | `{"type":"turn_complete"}` | back to "ready" |
| `onToolCall` | `{"type":"tool_call", name, args}` | screen reaction / song lookup started |
| `onReconnecting` / `onReconnected` | `{"type":"reconnecting"}` / `{"type":"ready"}` | the connection dropped and is retrying |
| `onPassiveListen` | `{"type":"passive_listen"}` | a side conversation was detected — no audio was played |

The `ws.on("message", ...)` handler is the browser → backend direction:
binary data is audio; JSON control messages are `start_turn`/`end_turn`
(the push-to-talk boundary) or the newer `select_activity` (tapping an
icon on the home screen — see `selectActivity` below).

`ws.on("close", ...)` is where a finished session's transcript gets turned
into next time's memory: `geminiSession.getTranscript()` (a rough
transcript accumulated inside `geminiSession.ts`) is handed to
`summarizeSession()` (`sessionSummarizer.ts`), and the result is folded
into the saved profile via `recordSession()` (`learningProfile.ts`) —
fire-and-forget, so it never delays the connection actually closing.

## `GET /recap` and `POST /api/v1/bot/chat` — the two extra HTTP endpoints

`/recap` is trivial: `loadProfile().sessions.slice(0, 10)`, returned as
JSON — the same session-history data structure `learningProfile.ts`
already maintains, just exposed for the frontend's `/recap` page (see
[Frontend Deep Dive](04-frontend-deep-dive.html)) to render.

`/api/v1/bot/chat` is more interesting: a **text-only companion** to the
real-time voice WebSocket, wiring the exact same side-conversation filter
and memory engine together over plain JSON, with no microphone needed —
useful for testing that pipeline directly. Given `{"transcriptData":
[{"speaker": "...", "text": "..."}]}` (the same diarized-segment shape
`audioProcessingEngine.ts` expects), it:

1. Runs `detectSideConversation()` on the segments.
2. Extracts facts into the long-term memory database either way
   (`analyzeAndExtractProfileFacts`, fire-and-forget).
3. If it's a side conversation: responds `{"response": null,
   "passiveListening": true, ...}` immediately — no text, no reply.
4. Otherwise: builds a system instruction from this child's known facts
   (`buildChildContextPrompt`), calls a **plain** `ai.models.generateContent`
   (not the Live API — see the box below for why that distinction
   matters), and returns the reply text.

The whole handler is wrapped in one `try`/`catch` that guarantees a normal
error response instead of ever throwing — a lesson learned the concrete
way: an early version of this endpoint could throw on a bad request and
take the *entire backend process* down with it, silently disconnecting
every other child's live voice session too. `server.ts` also registers a
top-level `process.on("uncaughtException", ...)` / `unhandledRejection`
handler as a last-resort safety net, logging instead of crashing, given
how many independent fire-and-forget background tasks (summarization,
fact extraction, lyrics lookup) this process now juggles at once.

> **Two different ways this backend talks to Gemini.** The Live API
> (`ai.live.connect`, wrapped by `geminiSession.ts`) is for the real-time
> voice conversation — bidirectional audio, one long-lived connection.
> Everything else in this file — session summaries, fact extraction, the
> `/api/v1/bot/chat` replies, song lyrics — uses a completely different,
> much simpler call: `ai.models.generateContent({ model, contents })`, a
> one-shot "here's some text, give me text back" request, the same shape
> you'd use for any ordinary AI chat feature with no audio involved at
> all. Both go through the same `@google/genai` package, but they're
> unrelated code paths with different capabilities and different costs.

## `geminiSession.ts` — one wrapped Gemini Live session

This file's job is translating between "what `server.ts` needs" (simple
method calls: `startTurn()`, `sendAudioChunk()`, `endTurn()`,
`selectActivity()`, `close()`) and "what the actual `@google/genai`
library's Gemini Live API expects" — isolating every Gemini-specific
detail into one file.

```typescript
const ai = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });

this.connecting = ai.live.connect({
  model: MODEL,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: buildTeacherSystemInstruction(memoryContext, {
      includeScreenTools: true,
      includeSongLookup: true,
    }),
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
    realtimeInputConfig: {
      automaticActivityDetection: { disabled: true },
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
  },
  callbacks: { onmessage, onerror, onclose },
}).then((session) => { this.session = session; });
```

Compared to the original version of this file, four things were added to
this config — each is its own section below:

- `inputAudioTranscription` / `outputAudioTranscription` — turns on
  Gemini's built-in speech-to-text for both sides of the conversation,
  which is what makes session summarization, fact extraction, and the
  side-conversation filter possible at all (none of them touch raw audio
  directly — they all work from this transcribed text).
- `sessionResumption` — opts into automatic-reconnect support.
- `tools: [{ functionDeclarations: TOOL_DECLARATIONS }]` — the three
  things the AI teacher can actively *do*, not just say (screen
  reactions, scene changes, song lookups).
- `buildTeacherSystemInstruction(memoryContext, { includeScreenTools: true, includeSongLookup: true })`
  — the persona is no longer one fixed string; see `teacherPersona.ts`
  below for why the options matter.

### Transcription and the running transcript

```typescript
if (message.serverContent?.inputTranscription?.text) {
  this.currentInputText += message.serverContent.inputTranscription.text;
}
```

Transcription arrives in small streamed chunks (not one block per turn),
so `geminiSession.ts` just keeps appending them to a running string,
separately for the child's speech and Gemini's own spoken response, and
flushes both into `transcriptLines` (one `"Child: ..."` / `"Teacher:
..."` line each) whenever `turnComplete` fires. `getTranscript()` just
joins those lines — this is a best-effort record, not a perfect one, but
it's exactly what `sessionSummarizer.ts` and the side-conversation filter
need.

### The three tools: `show_visual`, `set_scene`, `get_song_lyrics`

```typescript
const SCREEN_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "show_visual",
    description: "Shows one big visual on the child's screen... an emoji... a digit or short number... or a single letter...",
    parameters: { type: Type.OBJECT, properties: { content: { type: Type.STRING, ... } }, required: ["content"] },
  },
  {
    name: "set_scene",
    parameters: { type: Type.OBJECT, properties: { theme: { type: Type.STRING, enum: [...SCENE_THEMES] } }, required: ["theme"] },
  },
];
const SONG_LYRICS_DECLARATION: FunctionDeclaration = { name: "get_song_lyrics", /* ... */ };
```

A **`FunctionDeclaration`** is how you tell an AI model "here's an action
you're allowed to take, here's its name, and here's what arguments it
needs" — the model itself decides, mid-conversation, whether and when to
call one, based purely on its description and the current conversation.
Nothing here tells Gemini *when* to sing or show a number; that guidance
lives entirely in `teacherPersona.ts`'s prose instructions. The
declarations only define the *shape* of each action.

`show_visual` started life as `show_emoji` (emoji only) and was
generalized to accept any short `content` string — a number, a single
English or Telugu letter, or an emoji — because Telugu script (and most
letters generally) have no emoji representation at all, so the
emoji-only version genuinely couldn't be used for teaching the alphabet.

```typescript
private handleToolCall(call: FunctionCall): void {
  if (!call.name) return;
  this.callbacks.onToolCall(call.name, call.args ?? {});

  if (call.name === "get_song_lyrics") {
    void this.handleSongLyricsCall(call);
    return;
  }

  // show_visual / set_scene are pure, instant UI side effects
  this.session?.sendToolResponse({
    functionResponses: { id: call.id, name: call.name, response: { output: "ok" } },
  });
}
```

Every tool call **must** get a `sendToolResponse` eventually, or Gemini
will wait indefinitely — but not every tool needs to compute anything
first. `show_visual`/`set_scene` are pure UI side effects (there's
nothing for the *backend* to do besides tell the browser), so they're
acknowledged with a trivial `{output: "ok"}` immediately. `get_song_lyrics`
is different — answering it means a real (occasionally multi-second)
lookup via `songLyricsEngine.ts` (below), so it's routed to a separate
`async` method that only calls `sendToolResponse` once the actual lyrics
(or a "couldn't find it" signal) are in hand:

```typescript
private async handleSongLyricsCall(call: FunctionCall): Promise<void> {
  const songName = typeof call.args?.songName === "string" ? call.args.songName : "";
  const language = typeof call.args?.language === "string" ? call.args.language : "English";
  let output: Record<string, unknown>;
  try {
    const lyrics = await fetchSongLyrics(this.apiKey, songName, language);
    output = lyrics ? { lyrics } : { error: "..." };
  } catch (err) {
    output = { error: "..." };
  }
  this.session?.sendToolResponse({ functionResponses: { id: call.id, name: call.name, response: output } });
}
```

Note that even the *failure* case returns a normal-looking response
object (`{ error: "..." }`), not a thrown exception up through
`sendToolResponse` — the error message is written as an instruction for
the *model* to read and react to conversationally ("apologize briefly and
suggest a different song"), not a program-level error. This is a useful
pattern any time an AI-facing function can fail: give the model something
sensible to say about it, rather than crashing or going silent.

### Reacting to a tapped activity icon: `selectActivity` and `sendClientContent`

```typescript
selectActivity(activityId: string): void {
  const topic = ACTIVITY_TOPICS[activityId];
  if (!topic) return;
  this.session?.sendClientContent({
    turns: `[The child tapped the "${activityId}" button on their screen, asking to learn about ${topic}.]`,
    turnComplete: true,
  });
}
```

Everywhere else in this file, the child's side of the conversation is
audio, sent via `sendRealtimeInput`. `sendClientContent` is a different
method on the same `Session` object — it injects a **text** turn into the
*already-open* conversation, and (with `turnComplete: true`) immediately
triggers Gemini to respond, exactly as if that text had been said out
loud. This is what lets tapping an icon on the home screen steer an
ongoing conversation toward a topic without reconnecting — reconnecting
would mean opening a brand new session, losing the current
back-and-forth. The bracketed phrasing (`"[The child tapped..."]`) is a
deliberate signal to the model that this is stage direction, not literal
speech — `teacherPersona.ts`'s "WHEN THE CHILD TAPS AN ACTIVITY BUTTON"
section spells out exactly how it should react to seeing this.

### Reconnecting automatically: session resumption

```typescript
private handleUnexpectedClose(memoryContext: string): void {
  if (this.intentionalClose) return;
  if (this.hasReconnected || !this.resumptionHandle) { this.callbacks.onClose(); return; }
  this.hasReconnected = true;
  this.callbacks.onReconnecting();
  this.connecting = this.open(memoryContext, this.resumptionHandle)
    .then(() => this.callbacks.onReconnected())
    .catch((err) => this.callbacks.onError("..."));
}
```

Gemini periodically resets the underlying connection (this is normal, not
an error) and, because `sessionResumption` was requested in the config,
sends a `sessionResumptionUpdate` message beforehand containing a
**resumption handle** — a token that can be used to reopen the
conversation exactly where it left off, rather than starting fresh.
`intentionalClose` (set only by the `close()` method server.ts calls when
the browser disconnects) distinguishes "we hung up on purpose" from "the
connection dropped out from under us" — only the latter is worth
recovering from. `hasReconnected` caps this at exactly one retry, so a
persistently broken connection fails cleanly instead of looping forever.

## `teacherPersona.ts` — the AI's behavior, and why it's built from pieces now

```typescript
export function buildTeacherSystemInstruction(
  memoryContext: string,
  options: { includeScreenTools?: boolean; includeSongLookup?: boolean } = {}
): string {
  const sections = [BASE_INSTRUCTION];
  if (options.includeScreenTools) sections.push(SCREEN_TOOLS_INSTRUCTION);
  if (options.includeSongLookup) sections.push(SONG_LOOKUP_INSTRUCTION);
  if (memoryContext) sections.push(memoryContext);
  return sections.join("\n\n");
}
```

The persona used to be one fixed string. It's now assembled from pieces,
and the reason is a real bug worth understanding: `SCREEN_TOOLS_INSTRUCTION`
and `SONG_LOOKUP_INSTRUCTION` describe tools (`show_visual`, `set_scene`,
`get_song_lyrics`) that only exist where `geminiSession.ts` actually
declares them. The very first version of `/api/v1/bot/chat` (in
`server.ts`) reused the *entire* persona including those tool
instructions, on a plain `generateContent` call where no tools were
declared at all — and Gemini, told about a tool it couldn't actually see,
tried to call it anyway. The response came back completely empty, with
`finishReason: "MALFORMED_FUNCTION_CALL"` instead of any text. The fix is
this options-gated builder: each tool-specific instruction block is only
included by a caller that has actually wired up the matching tool.
`geminiSession.ts` passes both flags `true`; `/api/v1/bot/chat` (which
declares no tools) passes neither, and gets the plain base persona.

The base persona itself is unchanged in spirit from the original — one
continuous flow with no pause between acknowledging and answering,
natural English/Telugu code-switching, patience with fragmented toddler
speech, recasting instead of correcting — plus one new section, **"WHEN
THE CHILD TAPS AN ACTIVITY BUTTON,"** teaching the model to react to
`selectActivity`'s bracketed note (above) exactly as if the child had
asked out loud, and never mention "button" or "screen."

Because this instruction is just text (built by a plain function, not
hand-edited per caller), tuning the AI's behavior for a *specific*
capability is a matter of editing one clearly-named block, not hunting
through scattered strings.

## `learningProfile.ts` and `sessionSummarizer.ts` — session-level memory

These two files together answer "what did we talk about last time," and
they're deliberately simple: no database, just a JSON file
(`backend/data/learning-profile.json`).

`sessionSummarizer.ts` takes one session's raw transcript (from
`geminiSession.ts`'s `getTranscript()`) and asks a plain `generateContent`
call to distill it into structured JSON:

```typescript
const response = await ai.models.generateContent({
  model: SUMMARY_MODEL,
  contents: buildPrompt(transcript),
  config: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
});
```

`responseMimeType: "application/json"` plus a `responseSchema` is how you
ask Gemini to return **structured data** instead of free-form prose —
here, an object with `topics`, `newWords`, `strugglingWords`, and
`summaryForParent` fields, guaranteed to parse as valid JSON rather than
having to hope the model formats its prose response consistently.

`learningProfile.ts` then owns reading/writing that JSON file:
`loadProfile()`, `recordSession()` (merges a new summary in, capping how
much history is kept), and `buildMemoryContext()` — which turns the saved
profile back into a short block of text appended to the *next* session's
persona ("words this child already knows: ...", "topics covered
recently: ...").

Both files are written to **fail safe**: a missing/corrupt profile file
just starts fresh rather than crashing (`loadProfile`'s `catch` block),
and a failed summarization returns `null` rather than throwing
(`summarizeSession`'s `catch` block) — session memory is a genuine
enhancement, but it should never be able to take down the actual voice
conversation over a JSON parsing hiccup or a flaky API call.

## `botMemoryEngine.ts` — structured, per-child, long-term memory (SQLite)

Where `learningProfile.ts` tracks loose session-level summaries,
`botMemoryEngine.ts` tracks durable, categorized facts about the child —
"Hobby: soccer," "Pet Name: Rex," "Family: has a sister named Maya" — in
a real relational database, using Node's **built-in** `node:sqlite`
module (stable since Node 22, so nothing extra needs installing):

```typescript
const database = new DatabaseSync(DB_PATH);
database.exec(`
  CREATE TABLE IF NOT EXISTS child_profiles (
    id TEXT PRIMARY KEY, first_name TEXT NOT NULL, age INTEGER,
    current_vocabulary_tier TEXT NOT NULL DEFAULT 'Moderate'
  );
  CREATE TABLE IF NOT EXISTS long_term_memories (
    id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES child_profiles(id),
    fact_category TEXT NOT NULL, fact_value TEXT NOT NULL, last_mentioned_timestamp TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS interaction_metrics (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    average_words_per_turn REAL NOT NULL, detected_speaker_count INTEGER NOT NULL DEFAULT 1
  );
`);
```

This app has no multi-child login system, so every session shares one
`"default-child"` row (`ensureDefaultChildProfile()`) rather than
building an authentication system this feature doesn't otherwise need.

Three functions matter most:

- **`calculateVocabularyPacing(userMessage)`** — a pure, instant function
  with no AI call at all: it just counts words (`text.trim().split(/\s+/)`)
  and returns `"Simple"` (under 4 words), `"Moderate"`, or `"Advanced"`.
  Being a plain word count rather than an AI judgment call is deliberate
  — it runs on *every single turn* with zero added latency.
- **`analyzeAndExtractProfileFacts(childId, transcriptData)`** — the one
  function here that *does* call Gemini (with a `responseSchema`, the
  same pattern as `sessionSummarizer.ts`) to pull structured facts out of
  a snippet of conversation. Called from `geminiSession.ts` after every
  turn with real content, fire-and-forget.
- **`fetchChildContext(childId)`** / **`buildChildContextPrompt(context)`**
  — the read side: pulls this child's known facts and current
  vocabulary tier out of SQLite and turns them into the text block
  `server.ts` folds into the next session's persona (alongside
  `learningProfile.ts`'s session-summary block).

## `audioProcessingEngine.ts` — recognizing a side conversation

This answers: is the child actually talking to the bot, or talking *past*
it to someone else in the room? The file's own header comment is worth
reading in full for an important, explicitly-made tradeoff: this is
**not** real audio speaker diarization (telling different people's voices
apart from the raw sound) — that would need a whole separate
speech-processing stage running *ahead of* Gemini Live, adding real
latency to every turn, which cuts directly against this app's core design
of "one Gemini Live call handles everything, on purpose, for speed."
Instead, it's a **cheap, instant text heuristic**:

```typescript
export function detectSideConversation(segments: DiarizedSegment[]): SideConversationResult {
  const speakers = new Set(segments.map((s) => s.speaker));
  if (speakers.size > 1) {
    return { isSideConversation: true, reason: "multiple speakers detected in the same turn" };
  }
  const combinedText = segments.map((s) => s.text).join(" ");
  const { matched, reason } = looksAddressedToSomeoneElse(combinedText);
  return { isSideConversation: matched, reason };
}
```

Two signals, both instant (plain string/regex checks, zero network
calls): genuinely distinct speaker labels (only meaningful if a future
upstream change ever adds real diarization — today's single-microphone
input never produces more than one), and text patterns that suggest
someone else is being addressed — a family-role word ("mom," "nanna"), an
imperative aimed at a person ("clean your room"), or a direct
name-address pattern (`"..., Name"`).

`geminiSession.ts` calls this the moment the child's transcribed input for
a turn is marked `finished` — often *before* Gemini's own audio response
has started arriving, since there's a real gap between "child stopped
talking" and "first response chunk." If it's flagged, the turn's audio is
never relayed to the browser (`suppressAudioThisTurn`) and
`onPassiveListen()` fires instead of `onTurnComplete()` — the child hears
nothing, exactly as if the bot were quietly listening rather than
interrupting a family conversation. Fact extraction still runs on the
text either way, since whatever was said might still be worth
remembering.

## `songLyricsEngine.ts` — looking up real lyrics before singing

`fetchSongLyrics(apiKey, songName, language)` is a small function with an
unusually large lesson in its header comment, because getting it right
took two real, evidence-based fixes — a good case study in how an AI
feature's *exact* wording, not just its logic, decides whether it works:

**Fix one: don't force Google Search grounding.** The first version
passed `tools: [{ googleSearch: {} }]`, expecting "search the web" to
mean "more accurate." Tested directly: a well-known Telugu movie song
came back `NOT_FOUND` with grounding on, but returned complete, correct
lyrics from the model's own trained knowledge with grounding *off*. A
grounded answer that would cite and reproduce a real lyrics webpage
triggers noticeably stricter copyright caution than the model just
answering from what it already knows — the opposite of what "search for
better accuracy" was supposed to buy here.

**Fix two: prompt wording and ordering matter enormously.** Even after
removing grounding, the very same song still failed — because the prompt
led with an appropriateness/copyright framing ("being copyrighted is NOT
a reason to refuse"), and just *raising the topic* was enough to make the
model over-refuse a song it otherwise knows fine. What was verified,
across several real English and Telugu movie songs, to actually work:

```typescript
function buildPrompt(songName: string, language: string): string {
  return `What are the lyrics to the song "${songName}" (in ${language}...)?
Return just the lyrics, verse by verse... just the words as they're actually sung.

This is for a young child (2-5 years old). If the song contains any
romantic, sexual, violent, or scary lines, skip just those lines and
return the rest. If you don't know this song at all, say exactly
NOT_FOUND instead.`;
}
```

Ask directly, with zero hedging, *first* — the safety instruction comes
second, as a lightweight "skip objectionable lines" note rather than an
upfront gate the model has to justify passing. The takeaway generalizes
well beyond this one file: for a task like "recall something you already
know," raising caveats before the actual request can make a language
model more cautious than the caveats alone would predict — test the
*exact* wording you ship, not just the logic, especially for anything
safety-adjacent.

`fetchSongLyrics` itself is a single plain `generateContent` call, no
tools, wrapped in a `try`/`catch` that returns `null` on any failure —
same fail-safe pattern as the memory/summarization functions above; a
missing or refused song should make the AI teacher say "I don't know that
one," never crash the conversation.

---
[← Architecture Overview](02-architecture-overview.html) · [Next: Frontend Deep Dive →](04-frontend-deep-dive.html)
