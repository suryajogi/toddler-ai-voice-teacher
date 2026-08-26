---
layout: default
title: Start Here
---

# Start Here: How the Code Actually Works

*A from-zero technical walkthrough for a reader with no prior Node.js,
TypeScript, or React experience.*

The [main project site](./) and [`USAGE.md`](https://github.com/suryajogi/toddler-ai-voice-teacher/blob/main/USAGE.md)
already cover **what this app is** and **how to run it** on a Mac, iPhone,
or Android. This separate set of pages covers something different: **how
the code that makes it work is actually built**, file by file, assuming
you've never written a line of JavaScript/TypeScript before. If you
haven't read the [main site](./) yet, do that first — it explains the
product; this explains the engineering underneath it.

## What problem this app is solving, technically

A toddler presses a button, talks, and hears a spoken answer back,
instantly, in English, Telugu, or a natural mix of both. Under the hood,
that's three genuinely hard problems bolted together:

1. **Understand spoken audio** (in two languages, from a toddler, who
   doesn't speak in full clean sentences).
2. **Decide what to say back** (as a warm, safe, age-appropriate teacher).
3. **Speak the answer out loud**, fast enough that a toddler doesn't lose
   interest waiting.

Historically, building this meant chaining together three *separate*
services: a speech-to-text engine, a text-generating AI model, and a
text-to-speech engine — each with its own latency, its own quirks, and
its own failure points. This project instead uses **Google's Gemini Live
API**, which does all three at once, inside a single ongoing connection —
you stream it audio, and it streams audio back. That single design choice
is *why* this codebase is as small as it is: there's no separate
speech-recognition or voice-synthesis code anywhere in this repo, because
Gemini Live is doing that part.

## The two halves of the app, and why there are two at all

Exactly like a typical modern web app, this is two separate programs
talking to each other over the network:

```
┌───────────────────────┐                      ┌──────────────────────────┐
│ frontend/              │   WebSocket (raw     │ backend/                 │
│ Next.js + React,       │◀── audio + JSON  ───▶│ Node.js + TypeScript,    │
│ runs in the browser    │    control messages)  │ holds the API key,      │
│ (mic button, playback) │                      │ talks to Gemini Live     │
└───────────────────────┘                      └──────────────┬───────────┘
                                                                │ Gemini Live API
                                                                ▼
                                                        Google's servers
```

You might reasonably ask: if Gemini Live can already listen and speak,
why not have the browser talk to it directly, with no backend at all? Two
reasons, both deliberate:

1. **The API key must never reach the browser.** Anything sent to a
   browser is visible to whoever's using it (open the browser's developer
   tools, and it's right there) — so if the frontend held the real Gemini
   API key, anyone could extract it and rack up API usage on your
   account. The backend holds the key instead, and the browser only ever
   talks to *your* backend, never directly to Google.
2. **The AI teacher's persona and safety rules must be enforced
   server-side.** The instructions telling the model "you are a gentle
   toddler teacher, never discuss X, always respond warmly" live in
   `backend/src/teacherPersona.ts` — on the backend. If that lived in the
   browser instead, anyone could open developer tools and simply delete
   or rewrite those instructions before they ever reached the model.

## How to read this guide

1. **[Your Toolbox](01-your-toolbox.html)** — the terminal, npm, git, and
   just enough TypeScript to read this codebase, if any of that is new to
   you.
2. **[Architecture Overview](02-architecture-overview.html)** — what a
   WebSocket is (and how it differs from the more common REST-API style),
   and how audio is represented as data and streamed both directions.
3. **[Backend Deep Dive](03-backend-deep-dive.html)** — `server.ts`,
   `geminiSession.ts`, and `teacherPersona.ts`, explained.
4. **[Frontend Deep Dive](04-frontend-deep-dive.html)** — `page.tsx`,
   `audio.ts`, `voiceSocket.ts`, and the audio worklet, explained.
5. **[Glossary](05-glossary.html)** — every term used, in one place.

If you already know what a terminal, npm, TypeScript, and React are,
you can skip straight to [Architecture Overview](02-architecture-overview.html).

---
[Next: Your Toolbox →](01-your-toolbox.html)
