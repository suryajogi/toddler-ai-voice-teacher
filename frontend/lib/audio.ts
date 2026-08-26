// Mic capture (encoded to 16-bit PCM / 16kHz mono, matching Gemini Live's
// required input format) and streaming playback (16-bit PCM / 24kHz mono,
// Gemini Live's output format). Both sample rates are requested directly on
// the AudioContext so the browser handles any resampling — see
// public/pcm-recorder-worklet.js for the capture side.

export class MicStreamer {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;

  async start(onChunk: (pcm16: ArrayBuffer) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.audioWorklet.addModule("/pcm-recorder-worklet.js");

    const source = this.context.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.context, "pcm-recorder-processor");
    this.workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      onChunk(event.data);
    };
    source.connect(this.workletNode);
    // Not connected to context.destination — we don't want to hear our own mic.
  }

  stop(): void {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.context?.close();
    this.context = null;
  }
}

export class AudioPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 24000 });
      this.nextStartTime = this.context.currentTime;
    }
    return this.context;
  }

  /** Enqueues one PCM16/24kHz chunk for gapless sequential playback. */
  enqueue(pcm16: ArrayBuffer): void {
    const context = this.ensureContext();
    const int16 = new Int16Array(pcm16);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }

    const buffer = context.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(this.nextStartTime, context.currentTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  /** Call when the child interrupts / starts a new turn, to discard anything mid-playback. */
  reset(): void {
    this.context?.close();
    this.context = null;
  }
}
