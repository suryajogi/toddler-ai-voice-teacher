---
layout: default
title: Glossary
---

# Glossary

[← Frontend Deep Dive](04-frontend-deep-dive.html)

Every technical term used across this guide, alphabetically.

**AudioContext / Web Audio API** — the browser's built-in subsystem for
capturing, processing, and playing sound. See [Frontend Deep
Dive](04-frontend-deep-dive.html).

**AudioWorklet** — a piece of code that runs on its own dedicated,
real-time audio-processing thread, separate from ordinary page
JavaScript, because audio needs very precise, guaranteed timing. See
[Frontend Deep Dive](04-frontend-deep-dive.html).

**arrow function (`(x) => x + 1`)** — a compact way to write a small
function in TypeScript/JavaScript. See [Your
Toolbox](01-your-toolbox.html).

**backend / frontend** — the backend is the program that owns
server-side logic and secrets (here: `backend/`, Node.js); the frontend
is the program running in the user's browser (here: `frontend/`,
Next.js/React). See [Start Here](00-start-here.html).

**barge-in** — interrupting the AI's spoken response mid-sentence by
starting to speak again. See [Architecture
Overview](02-architecture-overview.html).

**base64** — a way of representing arbitrary binary data (like raw audio
bytes) as plain text, used when a transport layer expects text rather
than binary. See [Backend Deep Dive](03-backend-deep-dive.html).

**class** — a blueprint bundling data and behavior together. See [Your
Toolbox](01-your-toolbox.html).

**constructor** — the special method that runs once when a new instance
of a class is created. See [Your Toolbox](01-your-toolbox.html).

**discriminated union** — a TypeScript type that can be one of several
exact shapes, distinguished by a shared field (usually named `type`). See
[Frontend Deep Dive](04-frontend-deep-dive.html).

**fail safe** — code written so that a failure (a bad API response, a
missing file) falls back to a safe default (e.g. `null`, "start fresh")
instead of crashing or throwing further up — used throughout this
project's memory/summarization code, since none of those features should
ever be able to take down the live voice conversation. See [Backend Deep
Dive](03-backend-deep-dive.html).

**Fisher–Yates shuffle** — a standard algorithm for randomly reordering a
list with no bias, used to build the puzzle game's card deck. See
[Frontend Deep Dive](04-frontend-deep-dive.html).

**function calling / tool use** — a mechanism where an AI model is told
about a set of named actions ("tools") it's allowed to request, and can
decide mid-conversation to call one instead of (or alongside) speaking;
the calling program executes the real action and reports the result back.
This project's `show_visual`, `set_scene`, and `get_song_lyrics` are all
tools. See [Architecture Overview](02-architecture-overview.html) and
[Backend Deep Dive](03-backend-deep-dive.html).

**Gemini Live API** — Google's bidirectional, audio-native AI model API;
handles listening, understanding, and speaking in one ongoing connection,
which is why this project has no separate speech-to-text or
text-to-speech code. See [Start Here](00-start-here.html).

**git / GitHub** — git is version-control software; GitHub hosts git
repositories online. See [Your Toolbox](01-your-toolbox.html).

**Google Search grounding** — a Gemini API option that lets the model
search the web before answering, citing real sources. Notably, this
project deliberately does *not* use it for song lyrics — grounded answers
that would cite a real lyrics webpage turned out to trigger *stricter*
copyright caution than the model just answering from its own trained
knowledge. See [Backend Deep Dive](03-backend-deep-dive.html).

**interface (TypeScript)** — describes the required shape of a value,
with no implementation of its own. See [Your
Toolbox](01-your-toolbox.html).

**JSON** — the plain-text format used here for control messages sent over
the WebSocket (as opposed to the raw binary frames used for audio). See
[Architecture Overview](02-architecture-overview.html).

**Node.js** — a program that runs JavaScript/TypeScript outside a
browser, as an ordinary server process. See [Your
Toolbox](01-your-toolbox.html).

**npm / `package.json`** — npm is the tool that installs a JavaScript
project's third-party libraries, listed in `package.json`. See [Your
Toolbox](01-your-toolbox.html).

**node:sqlite** — Node.js's built-in SQLite database module (stable since
Node 22) — used for this project's long-term per-child memory, with
nothing extra to install. See [Backend Deep Dive](03-backend-deep-dive.html).

**optional chaining (`?.`)** — calls a method or reads a property only if
the thing on the left isn't null/undefined, avoiding a crash otherwise.
See [Backend Deep Dive](03-backend-deep-dive.html).

**PCM16 / sample rate (16kHz / 24kHz)** — PCM16 stores each audio sample
as a 16-bit integer; the sample rate is how many samples are captured per
second. This project uses 16kHz for microphone input and 24kHz for
Gemini's spoken output, matching what the Gemini Live API requires on
each side. See [Architecture Overview](02-architecture-overview.html).

**Promise / `async`/`await`** — a Promise is a placeholder for a value
that will exist eventually (used for anything that takes unpredictable
time, like a network call); `async`/`await` is an alternate syntax for
working with Promises. See [Your Toolbox](01-your-toolbox.html).

**push-to-talk** — the child must hold a button to speak, rather than the
app always listening for speech automatically. See [Architecture
Overview](02-architecture-overview.html).

**React** — the library the frontend's UI is built with; components are
functions describing what the UI should look like given current state.

**responseSchema / structured output** — an option on a Gemini API call
that forces the response to be valid JSON matching a given shape, instead
of free-form prose — used for session summaries and fact extraction so
the result can be parsed reliably rather than hoping the model formats
consistently. See [Backend Deep Dive](03-backend-deep-dive.html).

**`sendClientContent`** — a Gemini Live API method that injects a text
turn into an already-open session and (optionally) immediately triggers a
response, as if that text had been spoken — used to steer the AI
teacher's conversation toward a topic when the child taps an activity
icon, without needing to reconnect. See [Backend Deep
Dive](03-backend-deep-dive.html).

**session resumption** — a Gemini Live API feature where the server
periodically issues a token that can be used to reopen a dropped
connection exactly where it left off, rather than starting over. See
[Backend Deep Dive](03-backend-deep-dive.html).

**system instruction** — a block of instructions given to an AI model
once, up front, defining its persona/behavior/rules for the whole
session — here, the entire content of `teacherPersona.ts`. See [Backend
Deep Dive](03-backend-deep-dive.html).

**terminal / bash / shell** — a text-only window where commands are typed
and run directly. See [Your Toolbox](01-your-toolbox.html).

**TypeScript** — JavaScript plus optional type annotations, checked
before the code runs and removed before it actually executes. See [Your
Toolbox](01-your-toolbox.html).

**union type** — a TypeScript type that can be one of several listed
possibilities. See [Frontend Deep Dive](04-frontend-deep-dive.html).

**WebSocket** — a single, continuously-open connection between browser
and server that either side can send messages over at any time, as
opposed to a one-off request/response. See [Architecture
Overview](02-architecture-overview.html).

---
[← Frontend Deep Dive](04-frontend-deep-dive.html) · [Back to Start Here](00-start-here.html)
