# Using Toddler AI Voice Teacher on Your Devices

This covers what the project is, and how to run and use the Phase 1 voice
prototype on a Mac/laptop, and on an iPhone or Android phone. See
`README.md` for the technical architecture and `Toddler_AI_Voice_Teacher_Requirements.docx`
for the full project requirements.

## What this is

A voice-first AI teacher for a toddler. The child presses one button,
speaks in English, Telugu, or a natural mix of both, and hears an
immediate spoken response — no reading, no typing. It teaches the
alphabet, numbers, colors, animals, vocabulary, songs, and short stories,
in a warm, encouraging, age-appropriate way. This is the **Phase 1
prototype**: proving the core voice experience, before later phases add a
learning curriculum, progress tracking, and a parent dashboard.

## What you need

- A computer (Mac/laptop) to run the app — it's not deployed anywhere
  publicly yet, so it always runs from someone's machine for now.
- [Node.js](https://nodejs.org) installed on that machine.
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)
  (free to create; make sure the Live API is enabled for it).
- To use it from a phone: the phone on the **same Wi-Fi network** as the
  computer running the app.

## 1. On your Mac / laptop

This is the machine that actually runs the app; phones connect to it over
the network (see below).

```bash
git clone https://github.com/suryajogi/toddler-ai-voice-teacher.git
cd toddler-ai-voice-teacher

# Backend
cd backend
npm install
cp .env.example .env
# open .env and set GEMINI_API_KEY=<your key>
npm run dev
```

Leave that running, then in a second terminal:

```bash
cd toddler-ai-voice-teacher/frontend
npm install
npm run dev
```

Next.js will print a URL, typically `http://localhost:3000`. Open it in
Chrome or Safari **on that same Mac** — press and hold the button, speak,
and let go to hear the response.

## 2. On an iPhone or Android phone

This needs one extra step that isn't obvious, so read this part before
trying it: phones only allow a web page to use the microphone over a
secure (`https://`) connection, or on literally `localhost`. Your phone
isn't the computer running the app, so it can't use `localhost` — and a
plain local-network address like `http://192.168.1.83:3000` is treated as
insecure, so the browser will silently refuse microphone access even
though the page loads fine. This isn't a bug in this app; it's how every
phone browser works.

**The fix: a quick HTTPS tunnel**, using a free tool called `cloudflared`
(no account needed for this). Do this on the Mac, with both `npm run dev`
processes from step 1 already running:

```bash
brew install cloudflared

# Terminal 3 — tunnel the frontend (Next.js)
cloudflared tunnel --url http://localhost:3000

# Terminal 4 — tunnel the backend (the voice relay)
cloudflared tunnel --url http://localhost:8081
```

Each command prints a random `https://something.trycloudflare.com` URL —
note both of them. Then:

1. Take the **backend's** tunnel URL, swap `https://` for `wss://`, and add
   `/voice` at the end — e.g. `wss://random-words-1234.trycloudflare.com/voice`.
2. In `frontend/.env.local` (copy from `.env.local.example` if it doesn't
   exist yet), set `NEXT_PUBLIC_BACKEND_WS_URL` to that `wss://…/voice` URL.
3. Restart the frontend (`npm run dev` needs a restart to pick up the new
   env var).
4. On the iPhone or Android phone, open the **frontend's** tunnel URL
   (`https://something-else.trycloudflare.com`) in its browser.

The mic permission prompt should now appear normally — allow it, and the
button works the same as on the Mac.

Both tunnel URLs are temporary and change every time you re-run the
`cloudflared` commands, so you'll redo steps 1-3 each session. This is a
testing workaround for the current local-only prototype — a real hosted
deployment (planned for a later phase, per the project roadmap) would make
this unnecessary.

**Android-only shortcut, if you don't want to install anything:** Chrome on
Android has a flag, `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
where you can allowlist your Mac's `http://192.168.x.x:3000` address
directly, skipping the tunnel. This only works in Chrome on Android — iOS
Safari has no equivalent setting, so the tunnel is the only way to test on
an iPhone.

## Troubleshooting

- **"GEMINI_API_KEY is not configured on the server"** — you haven't set a
  real key in `backend/.env` yet, or the backend needs restarting after you
  added it.
- **Button never turns green / stays on "Connecting…"** — the frontend
  can't reach the backend. Check `NEXT_PUBLIC_BACKEND_WS_URL` matches
  wherever the backend is actually reachable (`localhost` on the same
  machine, the Mac's LAN IP or tunnel URL from a phone).
- **No microphone prompt appears on a phone** — you're on a plain
  `http://` address from a phone; see the tunnel steps above.
- **"Connection to voice server failed" right after it looked ready** —
  this can happen with an invalid/expired API key; double-check the key in
  `backend/.env` and that the Live API is enabled for it.
