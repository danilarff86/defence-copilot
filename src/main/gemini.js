'use strict';

// Talks to the Gemini REST API directly (no third-party SDK needed) — the main process's Node has fetch built in.
const { GenError } = require('./llm');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Streaming answer generation (single model, single attempt).
 * @param {function} [opts.onStart]  called once, right before output starts, after the server 200 is confirmed
 * @param {function} opts.onChunk    called with onChunk(textDelta) for each piece of text received
 * @returns {Promise<string>} the full text
 */
async function generateAnswerStream({
  apiKey,
  model,
  systemInstruction,
  userText,
  maxOutputTokens = 2048,
  temperature = 0.6,
  // Thinking budget: 0 = thinking disabled (faster, and thinking no longer eats into the output tokens and causes truncation)
  thinkingBudget = 0,
  signal,
  onStart,
  onChunk,
}) {
  if (!apiKey) throw new Error('Missing Gemini API Key');

  const url = `${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const buildBody = (withThinking) => ({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens,
      temperature,
      ...(withThinking && thinkingBudget != null ? { thinkingConfig: { thinkingBudget } } : {}),
    },
  });

  const post = (withThinking) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(withThinking)),
      signal,
    });

  let res = await post(thinkingBudget != null);
  // Some models reject thinkingConfig (400): drop that field and retry once
  if (!res.ok && res.status === 400 && thinkingBudget != null) {
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
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const obj = JSON.parse(payload);
      const parts = obj?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) {
          full += p.text;
          if (onChunk) onChunk(p.text);
        }
      }
    } catch (_e) {
      // Incomplete JSON line: ignore
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

module.exports = { generateAnswerStream };
