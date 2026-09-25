'use strict';

// Lists the models a provider offers, for the main-window model picker.
// Asks the provider's API live; with no key, on a network error, or on an empty
// response it falls back to the curated list in config.js so the picker is never empty.
const { PROVIDERS, resolveProvider } = require('./config');
const gemini = require('./gemini');
const anthropic = require('./anthropic');

const TIMEOUT_MS = 5000;
// Non-chat OpenAI models that /v1/models also returns
const OPENAI_EXCLUDE =
  /(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|search|moderation|instruct)/;

// Successful live lists, keyed by provider + key + base URL (a new key or URL refetches)
const cache = new Map();

const ids = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((m) => m && m.id)
    .filter((id) => typeof id === 'string' && id);
const sorted = (arr) => [...new Set(arr)].sort();

// Turns a list-endpoint response into model IDs. Exported for use by unit tests.
function parseModelList(kind, json) {
  switch (kind) {
    case 'openai':
      return sorted(
        ids(json?.data).filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !OPENAI_EXCLUDE.test(id)),
      );
    case 'openai-compat':
      return sorted(ids(json?.data));
    case 'gemini':
      return sorted(
        (Array.isArray(json?.models) ? json.models : [])
          .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m) => String(m.name || '').replace(/^models\//, ''))
          .filter((id) => id.startsWith('gemini')),
      );
    case 'anthropic':
      // The API returns newest first — keep that order
      return [...new Set(ids(json?.data))];
    default:
      return [];
  }
}

// The saved model always stays in the list (custom IDs, deprecated models)
function mergeModels(list, current) {
  return list.includes(current) ? [...list] : [current, ...list];
}

function listRequest(prov, kind) {
  if (kind === 'gemini') {
    return {
      url: `${gemini.BASE}/models?pageSize=1000&key=${encodeURIComponent(prov.apiKey)}`,
      headers: {},
    };
  }
  if (kind === 'anthropic') {
    return {
      url: `${anthropic.MODELS_URL}?limit=1000`,
      headers: { 'x-api-key': prov.apiKey, 'anthropic-version': anthropic.API_VERSION },
    };
  }
  // OpenAI-compatible: .../chat/completions → .../models
  return {
    url: prov.baseURL.replace(/\/chat\/completions\/?$/, '/models'),
    headers: prov.apiKey ? { Authorization: 'Bearer ' + prov.apiKey } : {},
  };
}

async function listModels(settings, { force = false, fetchFn = fetch } = {}) {
  const prov = resolveProvider(settings);
  const def = PROVIDERS[prov.id];
  const current = prov.models[0];
  const missingKey = prov.needsKey && !prov.apiKey;
  const base = { provider: prov.id, current, missingKey };
  const fallback = (error) => ({
    ...base,
    models: mergeModels(def.models, current),
    source: 'fallback',
    error,
  });

  if (missingKey) return fallback(`No ${prov.label} API key`);

  const key = [prov.id, prov.apiKey, prov.baseURL].join('|');
  let list = force ? null : cache.get(key);
  if (!list) {
    try {
      const { url, headers } = listRequest(prov, def.list);
      const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      // Only the status: a Gemini URL carries the key, so never echo the URL or body
      if (!res.ok) throw new Error(`${prov.label} returned HTTP ${res.status}`);
      list = parseModelList(def.list, await res.json());
      if (!list.length) throw new Error(`${prov.label} returned no models`);
      cache.set(key, list);
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? `${prov.label} did not respond` : e.message;
      // Redact the key if it appears in the error. apiKey may be '' (Ollama, no key needed);
      // splitting on '' would insert '***' between every character, so fall back to a NUL
      // separator that never occurs in a message, leaving it untouched.
      return fallback(
        String(msg || 'request failed')
          .split(prov.apiKey || '\0')
          .join('***'),
      );
    }
  }
  return { ...base, models: mergeModels(list, current), source: 'live' };
}

function clearCache() {
  cache.clear();
}

module.exports = { listModels, parseModelList, mergeModels, listRequest, clearCache };
