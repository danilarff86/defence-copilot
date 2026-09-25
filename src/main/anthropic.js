'use strict';

// Talks to the Anthropic Messages API directly over fetch (no SDK), like gemini.js / openaiCompat.js.
const { GenError } = require('./llm');

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const API_VERSION = '2023-06-01';

// Parses one SSE data payload. Returns { text } for a text delta, { error } for an
// error event, and null for everything else (thinking/signature deltas, pings, message_* events).
// Exported for use by unit tests.
function eventFromSSEData(payload) {
  if (!payload) return null;
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch (_e) {
    return null;
  }
  if (obj?.type === 'error') {
    const err = obj.error || {};
    return { error: `${err.type || 'error'}: ${err.message || 'stream error'}` };
  }
  if (obj?.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
    return typeof obj.delta.text === 'string' && obj.delta.text ? { text: obj.delta.text } : null;
  }
  return null;
}

/**
 * Streaming answer generation (single model, single attempt).
 * No temperature: current Claude models reject sampling parameters with a 400.
 * Thinking tokens count against max_tokens, so the budget is generous.
 */
async function generateAnswerStream({
  apiKey,
  model,
  systemInstruction,
  userText,
  maxOutputTokens = 8192,
  // Lower effort = less thinking = faster answers during a live interview
  effort = 'low',
  signal,
  onStart,
  onChunk,
}) {
  if (!apiKey) throw new Error('Missing Anthropic API Key');

  const buildBody = (withEffort) => ({
    model,
    max_tokens: maxOutputTokens,
    system: systemInstruction,
    messages: [{ role: 'user', content: userText }],
    stream: true,
    ...(withEffort ? { output_config: { effort } } : {}),
  });

  const post = (withEffort) =>
    fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(buildBody(withEffort)),
      signal,
    });

  let res = await post(!!effort);
  // Older models (e.g. Haiku 4.5) reject output_config.effort (400): drop it and retry once
  if (!res.ok && res.status === 400 && effort) {
    res = await post(false);
  }

  if (!res.ok || !res.body) {
    let txt = '';
    try {
      txt = await res.text();
    } catch (_e) {
      /* ignore */
    }
    throw new GenError(res.status, `Generation failed (${res.status}): ${txt.slice(0, 400)}`);
  }

  if (onStart) onStart();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const flushLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const ev = eventFromSSEData(t.slice(5).trim());
    if (!ev) return;
    // An error after output started (e.g. overloaded mid-stream): surface it, don't return a truncated answer
    if (ev.error) throw new GenError(500, `Generation failed: ${ev.error}`);
    full += ev.text;
    if (onChunk) onChunk(ev.text);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      flushLine(line);
    }
  }
  if (buffer) flushLine(buffer);

  return full;
}

module.exports = { generateAnswerStream, eventFromSSEData, MESSAGES_URL, MODELS_URL, API_VERSION };
