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

**Gemini Live API** — Google's bidirectional, audio-native AI model API;
handles listening, understanding, and speaking in one ongoing connection,
which is why this project has no separate speech-to-text or
text-to-speech code. See [Start Here](00-start-here.html).

**git / GitHub** — git is version-control software; GitHub hosts git
repositories online. See [Your Toolbox](01-your-toolbox.html).

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
