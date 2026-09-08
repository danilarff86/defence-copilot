// AudioWorklet: converts Float32 samples from the microphone/system audio to
// 16-bit PCM, buffering roughly 100ms before postMessage to cut message frequency.
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    // sampleRate is a global variable from AudioWorkletGlobalScope
    this._target = Math.max(1024, Math.floor(sampleRate * 0.1));
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0]; // Float32Array, typically 128 samples
      this._buf.push(ch.slice());
      this._count += ch.length;

      if (this._count >= this._target) {
        const merged = new Int16Array(this._count);
        let o = 0;
        for (const frame of this._buf) {
          for (let i = 0; i < frame.length; i++) {
            let s = frame[i];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            merged[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
        }
        this._buf = [];
        this._count = 0;
        this.port.postMessage(merged.buffer, [merged.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
