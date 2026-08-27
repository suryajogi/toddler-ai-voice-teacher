---
layout: default
title: Architecture Overview
---

# Architecture Overview

[← Your Toolbox](01-your-toolbox.html)

## Why this app uses a WebSocket, not a normal web request

Most web apps (including this project's sibling, `ai-agent-demo`) talk to
their backend using ordinary HTTP requests: the browser asks a question,
the server answers once, and the connection ends — a **request/response**
pattern. That works great for "give me a list of records," but it's the
wrong shape for a live conversation, where audio needs to keep flowing
**continuously, in both directions, at the same time**, for as long as
the child is talking or the AI is answering.

A **WebSocket** solves this: it's a single connection that, once opened,
**stays open**, and either side can send a message to the other at any
moment, without waiting for a "request" first. This project opens exactly
one WebSocket connection per visitor, the moment the page loads
(`ws://localhost:8081/voice`, defined in `backend/src/server.ts`), and
keeps it open for the entire session — the button press/release doesn't
open or close the connection, it just marks where one spoken "turn"
begins and ends *within* that already-open connection.

```
Browser                                          Backend                                    Google
┌────────────────────┐   WebSocket (stays open)  ┌────────────────────┐  Gemini Live API   ┌──────────┐
│ Press button        │ ── {"type":"start_turn"} ▶│                    │ ── activityStart ─▶│          │
│ Speak → mic chunks   │ ── binary PCM16 audio ──▶│  server.ts relays  │ ── audio chunks ──▶│  Gemini  │
│ Release button       │ ── {"type":"end_turn"} ──▶│  everything through│ ── activityEnd ───▶│  Live    │
│ Hear answer         │ ◀── binary PCM16 audio ──│  geminiSession.ts   │ ◀── audio chunks ──│          │
└────────────────────┘                          └────────────────────┘                    └──────────┘
```

## Two kinds of messages share one connection

Because a WebSocket is just "a channel two sides can send arbitrary
messages over," this project uses it for two different kinds of data at
once, distinguished by message type:

- **Binary frames** — raw audio data, sent as-is with no wrapping. The
  child's microphone audio flows browser → backend → Gemini this way; the
  AI's spoken response flows Gemini → backend → browser the same way.
- **Text frames, containing JSON** — control messages: `{"type":
  "start_turn"}` / `{"type": "end_turn"}` (browser → backend, marking
  when the child starts/stops speaking) and `{"type": "ready"}` /
  `{"type": "turn_complete"}` / `{"type": "interrupted"}` / `{"type":
  "error", "message": "..."}` (backend → browser, reporting what state
  the conversation is in).

Both `backend/src/server.ts` and `frontend/lib/voiceSocket.ts` contain a
small `if (isBinary) { ...audio... } else { ...JSON... }`-style check for
exactly this reason — one connection, two message shapes flowing through
it.

## What audio actually *is*, as data

Audio, digitally, is just a long list of numbers — each number a sample
of the sound wave's position, taken thousands of times per second.
**PCM16** ("16-bit Pulse-Code Modulation") means each sample is stored as
a plain 16-bit integer; **16kHz** or **24kHz** means 16,000 or 24,000
samples are taken per second respectively. This project deliberately uses
**two different rates for the two directions**, matching exactly what
Gemini Live requires: **16kHz mono, sent to Gemini** (the child's mic
input) and **24kHz mono, received back** (Gemini's spoken response) — see
`frontend/lib/audio.ts`'s two classes, `MicStreamer` and `AudioPlayer`,
each hard-coded to one of those two rates. Nothing in this codebase does
speech recognition or text-to-speech conversion itself — it only ever
captures raw audio, ships it over the WebSocket, and plays raw audio back
— all of the actual "understanding" and "speaking" happens inside Gemini
Live, on Google's servers.

## Why a mic button, not always-on listening

The frontend is **push-to-talk** — the child must hold a button to speak
— rather than continuously listening for when someone starts talking (a
technique called Voice Activity Detection, or VAD). This is a deliberate
choice, not a missing feature: Gemini Live's own built-in silence
detection defaults to waiting several seconds of quiet before deciding a
turn is over, which was adding most of the perceived response delay in
early testing. By having the browser's button press/release directly mark
"turn started" / "turn ended" (`geminiSession.ts`'s `startTurn()` /
`endTurn()`, sending `activityStart`/`activityEnd` straight to Gemini),
the app skips that guessing entirely — the app always knows precisely
when the child is done talking, because a human just told it so by
letting go of the button.

## "Barge-in": interrupting the AI mid-answer

Pressing the button again **while the AI is still talking** cuts its
response off immediately, rather than waiting for it to finish — this is
called "barge-in," and it's how real conversation actually works (people
interrupt each other). Two things have to happen together for this to
feel instant and clean, and both are visible directly in the code:

1. **Tell Gemini to stop generating** — `geminiSession.ts` sets
   `activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS`,
   meaning a fresh `activityStart` automatically cuts off whatever Gemini
   was in the middle of saying.
2. **Stop playing what's already arrived** — telling Gemini to stop
   doesn't retroactively un-send audio chunks that already made it to the
   browser before the interruption. `frontend/app/page.tsx`'s
   `handlePressStart()` calls `playerRef.current?.reset()` the instant a
   new press starts, and the backend relays Gemini's own `{"type":
   "interrupted"}` confirmation as a second safety net (see [Backend Deep
   Dive](03-backend-deep-dive.html) for exactly why both are needed).

## Where the safety/persona logic lives, and why there specifically

The AI's entire personality and behavior — warm tone, bilingual
code-switching, safety boundaries around personal information and
age-appropriate content — is a block of instructions assembled by
`backend/src/teacherPersona.ts`, sent to Gemini once, when each session
opens. It lives on the **backend**, never touched by the browser, for the
same reason the API key does: anything sent to the browser can be
inspected or tampered with by whoever's using it, and this instruction
text is exactly what must stay authoritative and untamperable. See
[Backend Deep Dive](03-backend-deep-dive.html) for the full breakdown of
what that instruction actually says and why — including why it's now
assembled from several pieces rather than one fixed string.

## Beyond talking: function calling lets the AI *do* things

Everything above covers the AI *saying* something back. Three more
capabilities — flashing something on the child's screen, changing the
background mood, and looking up real song lyrics before singing — work
completely differently, through a mechanism called **function calling**
(sometimes "tool use"): the backend tells Gemini, up front, about a small
set of named actions it's allowed to request (with a description of what
each one does and what inputs it needs), and Gemini can decide,
mid-conversation, to call one — the same way it decides what words to
say, just structured as a named action instead of speech. The backend
executes the actual action (updating a database, telling the browser to
flash an emoji) and reports back what happened, and Gemini continues the
conversation with that result in hand.

This is why a request like "can you sing X" can involve a real pause: the
model calls a tool, the backend goes and looks something up (occasionally
taking a few real seconds), and only then does Gemini continue speaking.
See [Backend Deep Dive](03-backend-deep-dive.html) for exactly which three
tools exist and how the instant ones differ from the slow one.

## Remembering across sessions, and the two different memory stores

Each Gemini Live connection is its own isolated conversation — nothing
carries over automatically when the child opens the app again tomorrow.
"Session memory" is something this app builds *on top of* the Live API,
not a feature of the API itself: after each conversation ends, the
backend asks a separate, plain (non-live) Gemini call to summarize what
was said, and saves the result so the *next* session's persona can be
built with that history already folded in. This is also why memory only
ever affects the next session, never adjusts mid-conversation — the
persona is fixed the moment a Live session opens.

There are two separate stores behind this, answering two different
questions, covered in full in [Backend Deep Dive](03-backend-deep-dive.html):
a JSON file tracking loose session-level summaries ("what did we talk
about lately"), and a small SQLite database tracking durable, categorized
facts about the child ("what do I know about this child" — favorite
color, pets, family). Both are populated by the same kind of plain,
one-shot Gemini call used for song lookups and the text-only
`/api/v1/bot/chat` endpoint — a completely different, simpler API surface
than the real-time Live connection, even though both go through the same
`@google/genai` package.

---
[← Your Toolbox](01-your-toolbox.html) · [Next: Backend Deep Dive →](03-backend-deep-dive.html)
