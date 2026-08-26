---
layout: default
title: Your Toolbox
---

# Your Toolbox: Terminal, npm, git, and TypeScript Basics

[← Back to Start Here](00-start-here.html)

## 1. The terminal, briefly

The **terminal** (Terminal.app on a Mac, running a program called
**bash** or **zsh**) is a text-only window: you type a command, press
Enter, it runs immediately — no menus, no clicking. Every terminal has a
**current directory** (the folder it's "standing in"), and `cd
<folder>` ("change directory") moves it — which is why every instruction
in this project starts with `cd backend` or `cd frontend`: you're telling
the terminal which folder's files the next command should act on.

The handful of commands `USAGE.md` actually has you run:

| Command | What it does |
|---|---|
| `git clone <url>` | Downloads a full copy of this project (see git, below) |
| `cd <folder>` | Moves into a folder |
| `npm install` | Downloads this project's JavaScript dependencies (see below) |
| `cp .env.example .env` | Copies a template settings file so you can fill in your own API key |
| `npm run dev` | Starts a local development server |
| `brew install cloudflared` | Installs a tool for exposing a local server to the internet temporarily (used for phone testing) |

## 2. Node.js, npm, and `package.json`

**Node.js** is a program that lets JavaScript/TypeScript run outside a
browser — as an ordinary backend server process, which is exactly what
`backend/src/server.ts` is. **npm** ("Node Package Manager") is the tool
that downloads and installs third-party libraries this project depends
on. `package.json`, in both `backend/` and `frontend/`, is just a list of
which libraries and versions are needed; `npm install` reads that list
and downloads everything into a `node_modules/` folder — this project's
equivalent of installing a plugin, done per-project rather than
system-wide, so different projects' dependency versions never clash on
the same machine.

`npm run dev` runs the specific command labeled `"dev"` inside
`package.json`'s `scripts` section — for the backend, that's a compiler
that runs TypeScript directly with live-reload; for the frontend, it's
Next.js's own development server. You don't need to open `package.json`
to use this project, but it's worth knowing that `npm run dev` isn't a
built-in magic command — it's just running whatever the project's own
`package.json` defines under that name.

## 3. git and GitHub, briefly

**Git** is version-control software: it records the full history of every
change ever made to a project's files. **GitHub** is a website that hosts
git repositories online, so anyone can download ("clone") a copy. `git
clone https://github.com/suryajogi/toddler-ai-voice-teacher.git` is the
one git command `USAGE.md` actually needs you to run — it downloads the
entire project, history included, onto your machine. You won't need any
other git commands just to run and use the app.

## 4. Just enough TypeScript to read this codebase

TypeScript is JavaScript (the language every web browser runs) plus
optional type annotations that get checked before the code runs, and
stripped out before the browser or Node.js actually executes it. You'll
recognize these shapes throughout `backend/src/` and `frontend/`:

**Variables and types:**
```typescript
const PORT = Number(process.env.PORT ?? 8081);
```
`const` declares a variable that won't be reassigned. `??` is the
"nullish coalescing" operator — "use the left side, unless it's
null/undefined, in which case use the right side" — so this line means
"use the `PORT` environment variable if one was set, otherwise default to
8081."

**Functions and arrow functions:**
```typescript
function sendJson(ws: WebSocket, payload: unknown): void { ... }
const onAudio = (pcm: Buffer) => { ws.send(pcm); };
```
Both are functions; `(args) => { ... }` ("arrow function") is a more
compact way to write a small function, especially one being passed as an
argument to something else (very common in this codebase — see
`geminiSession.ts`'s `callbacks` object, which is entirely arrow
functions).

**Classes:**
```typescript
export class GeminiVoiceSession {
  private session: Session | null = null;
  constructor(apiKey: string, callbacks: GeminiSessionCallbacks) { ... }
  startTurn(): void { ... }
}
```
A **class** bundles data (`private session`, meaning that field is only
accessible from inside this class) and behavior (methods like
`startTurn()`) together. `constructor` is the special method that runs
once, when a new instance of the class is created (`new
GeminiVoiceSession(...)`), typically used to set up initial state — this
project's backend creates exactly one `GeminiVoiceSession` per connected
browser.

**Interfaces:**
```typescript
export interface GeminiSessionCallbacks {
  onAudio: (pcm: Buffer) => void;
  onTurnComplete: () => void;
}
```
An `interface` describes the *shape* something must have, without
providing any implementation itself — "anything passed as
`GeminiSessionCallbacks` must have an `onAudio` function and an
`onTurnComplete` function." It's purely a compile-time check; nothing
about it exists once the code is actually running.

**`import`/`export`:**
```typescript
import { GeminiVoiceSession } from "./geminiSession.js";
export class GeminiVoiceSession { ... }
```
`export` makes something defined in one file usable from other files;
`import` pulls it in. This is how `server.ts` gets access to the
`GeminiVoiceSession` class actually defined in `geminiSession.ts`.

**`async`/`await` and Promises:**
```typescript
geminiSession.ready().then(() => sendJson(ws, { type: "ready" }));
```
Network operations (like opening the connection to Gemini) take an
unpredictable amount of time, so they return a **Promise** — a
placeholder for "a value that will exist eventually." `.then(callback)`
says "once that eventually finishes successfully, run this." (You'll also
see the `async`/`await` spelling of this same idea elsewhere in the
codebase — they're two ways of writing the identical thing.)

That's the complete vocabulary needed for [Backend Deep
Dive](03-backend-deep-dive.html) and [Frontend Deep
Dive](04-frontend-deep-dive.html) — everything else reads close enough to
plain English to follow inline.

---
[← Start Here](00-start-here.html) · [Next: Architecture Overview →](02-architecture-overview.html)
