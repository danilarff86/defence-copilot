'use strict';

// An OpenAI-compatible Chat Completions client (SSE streaming).
// Used for DeepSeek / OpenAI / Ollama and similar: just supply a different baseURL (+ an optional apiKey).
const { GenError } = require('./llm');

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';

// Extracts the text delta from one SSE data line's payload; ignores reasoning_content (the thinking chain is never shown).
// Exported for use by unit tests.
function deltaFromSSEData(payload) {
  if (!payload || payload === '[DONE]') return '';
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch (_e) {
    return '';
  }
  const delta = obj?.choices?.[0]?.delta?.content;
  return typeof delta === 'string' ? delta : '';
}

async function generateAnswerStream({
  apiKey,
  baseURL,
  model,
  systemInstruction,
  userText,
  maxOutputTokens = 2048,
  temperature = 0.6,
  signal,
  onStart,
  onChunk,
}) {
  const endpoint = baseURL || DEFAULT_ENDPOINT;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userText },
    ],
    stream: true,
    max_tokens: maxOutputTokens,
    temperature,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let txt = '';
    try {
      txt = await res.text();
    } catch (_e) {
      /* ignore */
    }
    throw new GenError(res.status, `生成失败 (${res.status}): ${txt.slice(0, 400)}`);
  }

  if (onStart) onStart();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const flushLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const delta = deltaFromSSEData(t.slice(5).trim());
    if (delta) {
      full += delta;
      if (onChunk) onChunk(delta);
    }
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

module.exports = { generateAnswerStream, deltaFromSSEData };
