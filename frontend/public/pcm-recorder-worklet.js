// Runs in the AudioWorklet global scope (no DOM/window access). Converts
// each 128-sample Float32 render quantum from the mic into 16-bit PCM and
// forwards it to the main thread. Assumes the AudioContext itself was
// constructed with sampleRate: 16000, so no resampling happens here — the
// browser's audio graph does that when the mic's native rate differs.
class PcmRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-recorder-processor", PcmRecorderProcessor);
