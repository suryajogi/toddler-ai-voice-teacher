import "dotenv/config";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { GeminiVoiceSession } from "./geminiSession.js";

const PORT = Number(process.env.PORT ?? 8081);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", geminiConfigured: !!GEMINI_API_KEY }));
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

  const geminiSession = new GeminiVoiceSession(GEMINI_API_KEY, {
    onAudio: (pcm) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
    },
    onTurnComplete: () => sendJson(ws, { type: "turn_complete" }),
    onError: (message) => {
      sendJson(ws, { type: "error", message });
      ws.close();
    },
    onClose: () => {
      sendJson(ws, { type: "closed" });
      ws.close();
    },
  });

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
      if (control.type === "end_turn") geminiSession.endTurn();
    } catch {
      console.warn("Ignoring malformed control message from client");
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    geminiSession.close();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Toddler AI Voice Teacher backend listening on :${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  Voice relay:  ws://localhost:${PORT}/voice`);
  if (!GEMINI_API_KEY) {
    console.warn(
      "  ⚠️  GEMINI_API_KEY is not set — connections will be told to add one. " +
        "Copy backend/.env.example to backend/.env and fill it in."
    );
  }
});
