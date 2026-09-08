// Deepgram real-time transcription client: uses the browser's native WebSocket,
// authenticating via the subprotocol ['token', apiKey] (the browser can't set request headers).

// Keep in sync with DEFAULTS.sttPauseMs in src/main/settings.js.
const DEFAULT_PAUSE_MS = 900;

class DeepgramLive {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.language  zh / en-US / uk / multi / …
   * @param {number} opts.sampleRate
   * @param {number} [opts.pauseMs]  Silence that ends a sentence (endpointing)
   * @param {function} opts.onTranscript  ({text, isFinal}) => void
   * @param {function} [opts.onState]      (state, info) => void
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.language = opts.language || 'zh';
    this.sampleRate = opts.sampleRate || 16000;
    this.pauseMs = opts.pauseMs || DEFAULT_PAUSE_MS;
    this.onTranscript = opts.onTranscript || (() => {});
    this.onState = opts.onState || (() => {});
    this.ws = null;
    this.keepAlive = null;
    this.closedByUser = false;
    // Chunks Deepgram has frozen (is_final) but that aren't a finished sentence
    // yet — held until end of speech so one utterance becomes one turn.
    this.pending = [];
  }

  connect() {
    const multi = this.language === 'multi';
    // Ukrainian is best served by nova-3 (nova-2 also supports it, but with
    // higher WER); other single languages keep nova-2 to avoid behavior change.
    const NOVA3_LANGS = new Set(['multi', 'uk']);
    const params = new URLSearchParams({
      model: NOVA3_LANGS.has(this.language) ? 'nova-3' : 'nova-2',
      smart_format: 'true',
      interim_results: 'true',
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1',
      endpointing: String(this.pauseMs),
      // Backstop for when steady background noise stops endpointing from ever
      // firing: Deepgram then sends UtteranceEnd instead. Its floor is 1000ms.
      utterance_end_ms: String(Math.max(1000, this.pauseMs)),
    });
    if (multi) params.set('language', 'multi');
    else params.set('language', this.language);

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    this.closedByUser = false;
    this.pending = [];

    try {
      this.ws = new WebSocket(url, ['token', this.apiKey]);
    } catch (e) {
      this.onState('error', e.message);
      return;
    }
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.onState('open');
      this.keepAlive = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8000);
    };

    this.ws.onmessage = (evt) => {
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch (_e) {
        return;
      }
      if (data.type === 'Results') {
        const alt = data.channel && data.channel.alternatives && data.channel.alternatives[0];
        const text = alt && alt.transcript ? alt.transcript.trim() : '';
        if (data.is_final) {
          // is_final only means "this text won't be revised" — Deepgram freezes
          // several such chunks per sentence. speech_final is the one that means
          // the speaker actually stopped.
          if (text) this.pending.push(text);
          if (data.speech_final) this.flush();
          else this.emitInterim('');
        } else if (text) {
          this.emitInterim(text);
        }
      } else if (data.type === 'UtteranceEnd') {
        this.flush();
      } else if (data.type === 'Error') {
        this.onState('error', data.description || data.message || 'Deepgram error');
      }
    };

    this.ws.onerror = () => {
      this.onState('error', 'WebSocket connection error (check Deepgram API Key / network)');
    };

    this.ws.onclose = (evt) => {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
      this.onState('closed', this.closedByUser ? '' : `Connection closed (${evt.code})`);
    };
  }

  // Show what's been heard so far — the buffered chunks plus the live tail —
  // so a long sentence stays visible while it's still being spoken.
  emitInterim(tail) {
    const text = this.pending.concat(tail ? [tail] : []).join(' ');
    if (text) this.onTranscript({ text, isFinal: false });
  }

  // End of utterance: commit the buffered chunks as a single turn.
  flush() {
    if (!this.pending.length) return;
    const text = this.pending.join(' ');
    this.pending = [];
    this.onTranscript({ text, isFinal: true });
  }

  send(buffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    // Don't drop a sentence that was still buffered when listening stopped.
    this.flush();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch (_e) {
        /* ignore */
      }
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_e) {
        /* ignore */
      }
    }
    this.ws = null;
  }
}

// The default is published on the class so app.js can fill the settings select
// from it — the renderer's scripts share one global scope, so a second top-level
// `const DEFAULT_PAUSE_MS` there would be a parse error.
DeepgramLive.DEFAULT_PAUSE_MS = DEFAULT_PAUSE_MS;

window.DeepgramLive = DeepgramLive;

// Exported for the unit tests; the renderer loads this file as a plain script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DeepgramLive, DEFAULT_PAUSE_MS };
}
