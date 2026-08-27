import "dotenv/config";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI } from "@google/genai";
import { GeminiVoiceSession } from "./geminiSession.js";
import { buildMemoryContext, loadProfile, recordSession } from "./learningProfile.js";
import { summarizeSession } from "./sessionSummarizer.js";
import { buildTeacherSystemInstruction } from "./teacherPersona.js";
import { DiarizedSegment, detectSideConversation } from "./audioProcessingEngine.js";
import {
  analyzeAndExtractProfileFacts,
  buildChildContextPrompt,
  calculateVocabularyPacing,
  ensureDefaultChildProfile,
  fetchChildContext,
  recordInteractionMetric,
} from "./botMemoryEngine.js";

// Defense-in-depth: this process now runs several fire-and-forget async
// tasks (fact extraction, session summarization) alongside the live
// WebSocket relay. None of them *should* ever throw uncaught, but if one
// somehow does, logging and continuing beats silently taking down every
// other connected child's live session over one background task's bug.
process.on("uncaughtException", (err) => console.error("Uncaught exception (backend stayed up):", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection (backend stayed up):", err));

const PORT = Number(process.env.PORT ?? 8081);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Plain text generation (not the Live API) — same model family used for
// session summarization (sessionSummarizer.ts) and fact extraction
// (botMemoryEngine.ts), reused here for /api/v1/bot/chat's text replies.
const CHAT_MODEL = process.env.GEMINI_SUMMARY_MODEL ?? "gemini-3.6-flash";

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function isDiarizedSegmentArray(value: unknown): value is DiarizedSegment[] {
  return (
    Array.isArray(value) &&
    value.every((s) => s && typeof s === "object" && typeof s.speaker === "string" && typeof s.text === "string")
  );
}

/**
 * Text-only companion to the real-time voice WebSocket below — wires the
 * same side-conversation filter (audioProcessingEngine.ts) and long-term
 * memory engine (botMemoryEngine.ts) together over plain HTTP/JSON, so the
 * full pipeline (filter -> extract facts -> reply, or filter -> extract
 * facts -> stay silent) can be exercised and tested without a microphone.
 * The voice pipeline (wss:.../voice) is still the actual product
 * experience — this is a secondary, text-based way into the same brain.
 */
async function handleBotChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!GEMINI_API_KEY) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GEMINI_API_KEY is not configured on the server." }));
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request body must be valid JSON." }));
    return;
  }

  const transcriptData = (body as { transcriptData?: unknown } | null)?.transcriptData;
  if (!isDiarizedSegmentArray(transcriptData) || transcriptData.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: 'Expected { "transcriptData": [{ "speaker": string, "text": string }, ...] } with at least one segment',
      })
    );
    return;
  }

  // Everything past this point touches SQLite and/or calls out to Gemini —
  // wrapped in one try/catch so a request that hits a real problem (a
  // storage error, a bad response from the model) returns a normal 500
  // instead of crashing the whole backend process, taking the live voice
  // WebSocket down with it for every other connected child.
  try {
    const childId = ensureDefaultChildProfile();
    const filterResult = detectSideConversation(transcriptData);

    // Whatever was said is worth remembering either way — extraction runs
    // in the background regardless of whether the bot actually replies.
    analyzeAndExtractProfileFacts(childId, transcriptData).catch((err) =>
      console.error("Fact extraction failed (non-fatal):", err)
    );

    if (filterResult.isSideConversation) {
      // Per spec: the bot stays SILENT — response is null — and just
      // passively listens/extracts facts in the background above.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response: null, passiveListening: true, reason: filterResult.reason }));
      return;
    }

    const childMessage = transcriptData.map((s) => s.text).join(" ");
    const vocabularyPacing = calculateVocabularyPacing(childMessage);
    recordInteractionMetric("http-chat", childMessage);

    const childContext = fetchChildContext(childId);
    const systemInstruction = buildTeacherSystemInstruction(buildChildContextPrompt(childContext));

    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const result = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents: childMessage,
      config: { systemInstruction },
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ response: result.text ?? null, passiveListening: false, vocabularyPacing }));
  } catch (err) {
    console.error("/api/v1/bot/chat request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error." }));
    }
  }
}

const httpServer = http.createServer((req, res) => {
  // All three JSON endpoints below are fetched directly from the
  // frontend's browser origin (a different port), so they need an explicit
  // CORS header — unlike /voice, which is a WebSocket and isn't subject to
  // the browser's same-origin fetch restrictions.
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", geminiConfigured: !!GEMINI_API_KEY }));
    return;
  }

  if (req.url === "/recap") {
    const profile = loadProfile();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: profile.sessions.slice(0, 10) }));
    return;
  }

  if (req.url === "/api/v1/bot/chat" && req.method === "POST") {
    void handleBotChat(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/voice" });

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

wss.on("connection", (ws) => {
  console.log("Client connected");

  if (!GEMINI_API_KEY) {
    sendJson(ws, {
      type: "error",
      message:
        "GEMINI_API_KEY is not configured on the server. Add it to backend/.env " +
        "(see backend/.env.example) and restart the backend.",
    });
    ws.close();
    return;
  }

  // Session memory: pull in what's been learned across past sessions
  // (learningProfile.ts — session-level topics/summaries) and durable
  // per-child facts (botMemoryEngine.ts — structured long-term memories)
  // so the persona (teacherPersona.ts) can build on both instead of
  // starting cold every time.
  const childId = ensureDefaultChildProfile();
  const sessionId = randomUUID();
  const profile = loadProfile();
  const childContext = fetchChildContext(childId);
  const memoryContext = [buildMemoryContext(profile), buildChildContextPrompt(childContext)]
    .filter(Boolean)
    .join("\n\n");
  const sessionStartedAt = new Date();

  const geminiSession = new GeminiVoiceSession(
    GEMINI_API_KEY,
    {
      onAudio: (pcm) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
      },
      onTurnComplete: () => sendJson(ws, { type: "turn_complete" }),
      onInterrupted: () => sendJson(ws, { type: "interrupted" }),
      onToolCall: (name, args) => sendJson(ws, { type: "tool_call", name, args }),
      onReconnecting: () => sendJson(ws, { type: "reconnecting" }),
      onReconnected: () => sendJson(ws, { type: "ready" }),
      onPassiveListen: () => sendJson(ws, { type: "passive_listen" }),
      onError: (message) => {
        sendJson(ws, { type: "error", message });
        ws.close();
      },
      onClose: () => {
        sendJson(ws, { type: "closed" });
        ws.close();
      },
    },
    childId,
    sessionId,
    memoryContext
  );

  geminiSession
    .ready()
    .then(() => sendJson(ws, { type: "ready" }))
    .catch((err) => {
      console.error("Failed to open Gemini Live session:", err);
      sendJson(ws, {
        type: "error",
        message: "Could not connect to Gemini Live. Check GEMINI_API_KEY and GEMINI_LIVE_MODEL.",
      });
      ws.close();
    });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      geminiSession.sendAudioChunk(Buffer.from(data as Buffer));
      return;
    }
    try {
      const control = JSON.parse(data.toString());
      if (control.type === "start_turn") geminiSession.startTurn();
      else if (control.type === "end_turn") geminiSession.endTurn();
    } catch {
      console.warn("Ignoring malformed control message from client");
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    geminiSession.close();

    // Fire-and-forget: summarize whatever was said this session and fold it
    // into the learning profile for next time. Never blocks the connection
    // teardown above, and summarizeSession() fails safe (returns null) on
    // any error rather than throwing.
    const transcript = geminiSession.getTranscript();
    if (transcript.trim()) {
      summarizeSession(GEMINI_API_KEY, transcript)
        .then((summary) => {
          if (!summary) return;
          const latestProfile = loadProfile(); // re-read in case another session wrote since we started
          recordSession(latestProfile, summary, sessionStartedAt, new Date());
          console.log(`Session summarized: ${summary.summaryForParent}`);
        })
        .catch((err) => console.error("Unexpected error recording session summary:", err));
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Toddler AI Voice Teacher backend listening on :${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  Parent recap: http://localhost:${PORT}/recap`);
  console.log(`  Text chat:    POST http://localhost:${PORT}/api/v1/bot/chat`);
  console.log(`  Voice relay:  ws://localhost:${PORT}/voice`);
  if (!GEMINI_API_KEY) {
    console.warn(
      "  ⚠️  GEMINI_API_KEY is not set — connections will be told to add one. " +
        "Copy backend/.env.example to backend/.env and fill it in."
    );
  }
});
