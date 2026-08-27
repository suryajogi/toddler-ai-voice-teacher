// Thin client for the backend's WebSocket voice relay (backend/src/server.ts).
// Binary frames are raw PCM16 audio; JSON text frames are control messages.

export type VoiceEvent =
  | { type: "ready" }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "closed" }
  | { type: "error"; message: string }
  | { type: "audio"; data: ArrayBuffer }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "reconnecting" }
  | { type: "passive_listen" };

export class VoiceSocket {
  private ws: WebSocket | null = null;

  connect(url: string, onEvent: (event: VoiceEvent) => void): void {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        onEvent({ type: "audio", data: event.data });
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        onEvent(parsed as VoiceEvent);
      } catch {
        // Ignore malformed control messages.
      }
    };
    ws.onerror = () => onEvent({ type: "error", message: "Connection to voice server failed." });
    ws.onclose = () => onEvent({ type: "closed" });
  }

  startTurn(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "start_turn" }));
  }

  sendAudioChunk(pcm16: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm16);
  }

  endTurn(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "end_turn" }));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
