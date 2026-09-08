'use strict';

// Cross-Provider common layer: error type + retry/fallback logic.
// The concrete streaming implementation is provided by each provider's generateAnswerStream (gemini.js / openaiCompat.js).

const TRANSIENT = new Set([429, 500, 502, 503, 504]);

class GenError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GenError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Try models in order; a transient error (429/5xx) is retried first, and only
 * moves to the next model if it still fails; once output has started
 * (onStart has fired) it no longer switches.
 * @param {function} opts.streamFn  the provider's generateAnswerStream
 * @returns {Promise<{model:string, text:string}>}
 */
async function generateWithFallback({ streamFn, models, retries = 1, onStart, ...rest }) {
  let started = false;
  let lastErr = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const text = await streamFn({
          ...rest,
          model,
          onStart: () => {
            started = true;
            if (onStart) onStart(model);
          },
        });
        return { model, text };
      } catch (e) {
        lastErr = e;
        if (started) throw e;
        if (e.name === 'AbortError') throw e;
        const transient = e.status && TRANSIENT.has(e.status);
        if (transient && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error('Generation failed: all models are unavailable');
}

module.exports = { GenError, TRANSIENT, generateWithFallback };
