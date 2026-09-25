# Model Picker + Anthropic Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Choose the answer provider in Settings, choose the model from a dropdown in the main window (populated live from the provider's API with a built-in fallback), and add Anthropic as a provider alongside OpenAI, Gemini, DeepSeek and Ollama.

**Architecture:** A new `anthropic.js` streams from the Messages API with the same `generateAnswerStream` contract as `gemini.js` / `openaiCompat.js`, so `llm.generateWithFallback` needs no changes. `resolveProvider` moves from `main.js` into `config.js` (testable, shared). A new `models.js` lists models per provider (live fetch → curated fallback, in-memory cache), exposed via two IPC calls (`list-models`, `select-model`). The renderer gains a top-bar `Model` select; the per-provider model text inputs leave the Settings dialog. Storage keeps the existing per-provider model fields, so no settings migration.

**Tech Stack:** Electron 44 (main = Node ≥ 22.12, global `fetch`), plain JS (CommonJS), `node:test`, ESLint, Prettier.

**Spec:** The in-chat design approved in this session (no spec file — bounded change). Its content is reproduced in "Design summary" below; this plan is the authoritative copy.

## Design summary

- Providers: `deepseek`, `openai`, `ollama`, `gemini`, **`anthropic` (new)**. Provider is chosen in Settings (unchanged select + new option).
- Model is chosen in the main-window top bar. The list comes from the provider's list endpoint (OpenAI `/v1/models` filtered to chat models; Gemini `/v1beta/models` filtered to `generateContent`; Anthropic `/v1/models`; DeepSeek/Ollama OpenAI-compatible `/models` derived from the chat-completions URL). On no key / error / empty response → curated list from `config.js`, flagged `source: 'fallback'`. The saved model is always in the list.
- Picking a model saves it immediately into that provider's own field (`genModel`, `openaiModel`, `deepseekModel`, `ollamaModel`, `anthropicModel`), so each provider remembers its last model.

### Decisions made while planning (review these)

1. **Anthropic via raw `fetch`, not `@anthropic-ai/sdk`.** Every existing provider is hand-rolled over `fetch` with a shared retry/fallback layer (`llm.js`) and the project has two runtime deps. Adding the SDK for one provider would split error/abort handling across two styles. Revisit if the Anthropic integration grows beyond one streaming call.
2. **Default Anthropic model `claude-opus-5`; generation fallback `claude-sonnet-5`.** Curated list: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`. Change the default if you prefer lower latency/cost.
3. **No `temperature` for Anthropic.** Sampling params return 400 on current Claude models (Opus 4.7+, Sonnet 5, Opus 5/5.5).
4. **`output_config: { effort: 'low' }` for Anthropic**, retried once without it on a 400 (Haiku 4.5 / older models reject `effort`) — mirrors `gemini.js`'s `thinkingConfig` retry. Keeps live-interview latency down; thinking is on by default on Opus 5/5.5 and can't be disabled on 5.5, so `max_tokens` is generous (8192) because thinking tokens count against it.
5. **HTTP 529 (Anthropic "overloaded") becomes transient** in `llm.js`, so it retries and falls back like 503.
6. **Startup key check fixed:** `init()` currently opens Settings whenever `geminiApiKey` is empty, regardless of provider. It will check the *selected* provider's key instead (via `missingKey` from `list-models`).

## Global Constraints

- Work on branch `feat/model-picker-anthropic` (never commit on `main`).
- Node ≥ 22.12 — use global `fetch`, `AbortSignal.timeout`; no new npm dependencies.
- CommonJS, `'use strict';` at top of every main-process file; match existing comment density and English-only strings.
- Anthropic request headers: `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`. Endpoints: `https://api.anthropic.com/v1/messages`, `https://api.anthropic.com/v1/models`.
- Model-list fetch timeout: 5000 ms. Never include an API key in an error message surfaced to the UI (Gemini puts the key in the URL — only report status codes).
- The renderer never calls LLM/provider APIs (CSP stays unchanged); all provider HTTP happens in the main process.
- `npm test`, `npm run lint`, `npm run format:check` must pass at the end of every task.
- Commits end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **Saved model missing from the live list** (custom ID, deprecated model, fine-tune) → it still appears and stays selected. Pinned by `mergeModels` tests in Task 3.
2. **Provider unreachable** (Ollama not running, offline, 401 bad key, 5 s hang) → dropdown shows the curated list, no exception, tooltip/toast explains why. Pinned by `listModels` fetch-reject / non-ok / timeout-signal tests in Task 3.
3. **Anthropic mid-stream `error` event** (e.g. `overloaded_error` after output began) → surfaced as an error, not a silently truncated answer. Pinned in Task 1.
4. **Older Claude model rejects `output_config.effort`** (400) → one retry without it succeeds. Pinned in Task 1.
5. **Provider switched while a model-list request is in flight** → the stale response must not repopulate the dropdown with the other provider's models. Pinned by the `provider` field test in Task 3 plus the sequence guard in Task 5 (manual check in Task 5 Step 7).

---

### Task 0: Branch

- [ ] **Step 1:** `git checkout -b feat/model-picker-anthropic`
- [ ] **Step 2:** `npm test` — Expected: all existing tests PASS (baseline).

---

### Task 1: Anthropic streaming client (+ 529 transient)

**Files:**
- Create: `src/main/anthropic.js`
- Modify: `src/main/llm.js:6` (TRANSIENT set)
- Test: `test/anthropic.test.js` (new), `test/llm.test.js` (append)

**Interfaces:**
- Consumes: `GenError` from `src/main/llm.js`.
- Produces:
  - `generateAnswerStream({ apiKey, model, systemInstruction, userText, maxOutputTokens = 8192, effort = 'low', signal, onStart, onChunk }) → Promise<string>` (extra props such as `baseURL`, `thinkingBudget` are ignored).
  - `eventFromSSEData(payload: string) → { text: string } | { error: string } | null`
  - constants `MESSAGES_URL`, `MODELS_URL`, `API_VERSION`.

- [ ] **Step 1: Write the failing tests** — `test/anthropic.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { eventFromSSEData, generateAnswerStream } = require('../src/main/anthropic');

const data = (obj) => JSON.stringify(obj);

test('eventFromSSEData: extracts text_delta', () => {
  const p = data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } });
  assert.deepEqual(eventFromSSEData(p), { text: 'Hi' });
});

test('eventFromSSEData: ignores thinking/signature deltas, pings and message events', () => {
  assert.equal(eventFromSSEData(data({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } })), null);
  assert.equal(eventFromSSEData(data({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 's' } })), null);
  assert.equal(eventFromSSEData(data({ type: 'ping' })), null);
  assert.equal(eventFromSSEData(data({ type: 'message_stop' })), null);
});

test('eventFromSSEData: error event is reported', () => {
  const p = data({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.deepEqual(eventFromSSEData(p), { error: 'overloaded_error: Overloaded' });
});

test('eventFromSSEData: empty or malformed payload does not throw', () => {
  assert.equal(eventFromSSEData(''), null);
  assert.equal(eventFromSSEData('{not json'), null);
});

// ---- generateAnswerStream with a stubbed global fetch ----

function sseResponse(lines, status = 200) {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

const textEvent = (t) =>
  'data: ' + data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });

test('generateAnswerStream: streams text, sends required headers, no temperature', async () => {
  const seen = [];
  await withFetch(
    async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      return sseResponse(['event: content_block_delta', textEvent('Hel'), '', textEvent('lo'), '']);
    },
    async () => {
      const chunks = [];
      let started = 0;
      const full = await generateAnswerStream({
        apiKey: 'k',
        model: 'claude-opus-5',
        systemInstruction: 'sys',
        userText: 'q',
        onStart: () => started++,
        onChunk: (d) => chunks.push(d),
      });
      assert.equal(full, 'Hello');
      assert.deepEqual(chunks, ['Hel', 'lo']);
      assert.equal(started, 1);
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].init.headers['x-api-key'], 'k');
  assert.equal(seen[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].body.system, 'sys');
  assert.equal(seen[0].body.stream, true);
  assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: 'q' }]);
  assert.deepEqual(seen[0].body.output_config, { effort: 'low' });
  assert.equal('temperature' in seen[0].body, false);
});

test('generateAnswerStream: 400 on effort → retries once without output_config', async () => {
  const bodies = [];
  await withFetch(
    async (_url, init) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if (b.output_config) return new Response('{"error":"effort unsupported"}', { status: 400 });
      return sseResponse([textEvent('ok')]);
    },
    async () => {
      const full = await generateAnswerStream({ apiKey: 'k', model: 'claude-haiku-4-5', systemInstruction: 's', userText: 'q' });
      assert.equal(full, 'ok');
    },
  );
  assert.equal(bodies.length, 2);
  assert.equal('output_config' in bodies[1], false);
});

test('generateAnswerStream: non-ok response throws GenError with status', async () => {
  await withFetch(
    async () => new Response('overloaded', { status: 529 }),
    () =>
      assert.rejects(
        () => generateAnswerStream({ apiKey: 'k', model: 'm', systemInstruction: 's', userText: 'q' }),
        (e) => e.name === 'GenError' && e.status === 529,
      ),
  );
});

test('generateAnswerStream: mid-stream error event rejects instead of truncating', async () => {
  const errLine = 'data: ' + data({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  await withFetch(
    async () => sseResponse([textEvent('partial'), errLine]),
    () =>
      assert.rejects(
        () => generateAnswerStream({ apiKey: 'k', model: 'm', systemInstruction: 's', userText: 'q' }),
        /overloaded_error: Overloaded/,
      ),
  );
});

test('generateAnswerStream: missing key throws before any request', async () => {
  let called = false;
  await withFetch(
    async () => {
      called = true;
    },
    () => assert.rejects(() => generateAnswerStream({ apiKey: '', model: 'm', systemInstruction: 's', userText: 'q' }), /Missing Anthropic API Key/),
  );
  assert.equal(called, false);
});
```

Append to `test/llm.test.js`:

(Non-transient errors also move to the next model, so the test uses `retries: 1` and asserts the retry to tell transient from non-transient.)

```js
test('529 (Anthropic overloaded) is retried like other transient errors', async () => {
  const fn = makeStreamFn({ a: 529, b: 'ok' });
  const r = await generateWithFallback({ streamFn: fn, models: ['a', 'b'], retries: 1 });
  assert.equal(r.model, 'b');
  assert.deepEqual(fn.calls, ['a', 'a', 'b']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/anthropic.test.js test/llm.test.js`
Expected: FAIL — `Cannot find module '../src/main/anthropic'`; the 529 test fails with `calls` = `['a', 'b']`.

- [ ] **Step 3: Implement** — `src/main/anthropic.js`

```js
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
```

`src/main/llm.js:6` — change to:

```js
// 529 = Anthropic "overloaded"
const TRANSIENT = new Set([429, 500, 502, 503, 504, 529]);
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/anthropic.test.js test/llm.test.js && npm run lint && npx prettier --write src/main/anthropic.js test/anthropic.test.js test/llm.test.js`
Expected: all PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/anthropic.js src/main/llm.js test/anthropic.test.js test/llm.test.js
git commit -m "feat: add Anthropic Messages API streaming client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Register Anthropic; move `resolveProvider` into `config.js`

**Files:**
- Modify: `src/main/config.js` (whole file)
- Modify: `src/main/main.js:20-41` (remove local `resolveProvider`, import it), `src/main/main.js:336-349` (token budgets)
- Modify: `src/main/gemini.js` (export `BASE`)
- Modify: `src/main/settings.js` (DEFAULTS)
- Modify: `.env.example`, `README.md`, `package.json` (description/keywords), `CHANGELOG.md`
- Test: `test/config.test.js` (new)

**Interfaces:**
- Consumes: `anthropic.generateAnswerStream` (Task 1).
- Produces (from `src/main/config.js`):
  - `PROVIDERS[id]` gains `list: 'openai' | 'openai-compat' | 'gemini' | 'anthropic'` and `models: string[]` (curated fallback list, contains `defaultModel`).
  - `resolveProvider(settings) → { id, label, type, needsKey, apiKey, baseURL, models: string[] /* [selected, ...fallbacks] */, streamFn }` — same shape as today.
  - `modelSetting(settings, model: string) → { [modelField]: string } | null` — the settings partial that stores `model` for the current provider; `null` for a blank model.

- [ ] **Step 1: Write the failing tests** — `test/config.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PROVIDERS, resolveProvider, modelSetting } = require('../src/main/config');
const { DEFAULTS } = require('../src/main/settings');
const anthropic = require('../src/main/anthropic');
const gemini = require('../src/main/gemini');
const openaiCompat = require('../src/main/openaiCompat');

test('every provider has a consistent registry entry', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.models.includes(p.defaultModel), `${id}: defaultModel is in the curated list`);
    assert.ok(p.modelField in DEFAULTS, `${id}: ${p.modelField} has a settings default`);
    if (p.keyField) assert.ok(p.keyField in DEFAULTS, `${id}: ${p.keyField} has a settings default`);
    assert.ok(['openai', 'openai-compat', 'gemini', 'anthropic'].includes(p.list), `${id}: list kind`);
  }
});

test('anthropic is registered with its own key and model fields', () => {
  const p = PROVIDERS.anthropic;
  assert.equal(p.type, 'anthropic');
  assert.equal(p.keyField, 'anthropicApiKey');
  assert.equal(p.modelField, 'anthropicModel');
  assert.equal(DEFAULTS.anthropicModel, p.defaultModel);
});

test('resolveProvider: picks the stream implementation by type', () => {
  assert.equal(resolveProvider({ provider: 'anthropic' }).streamFn, anthropic.generateAnswerStream);
  assert.equal(resolveProvider({ provider: 'gemini' }).streamFn, gemini.generateAnswerStream);
  assert.equal(resolveProvider({ provider: 'openai' }).streamFn, openaiCompat.generateAnswerStream);
});

test('resolveProvider: unknown provider falls back to gemini; blank model to default', () => {
  const r = resolveProvider({ provider: 'nope', genModel: '  ' });
  assert.equal(r.id, 'gemini');
  assert.equal(r.models[0], PROVIDERS.gemini.defaultModel);
});

test('resolveProvider: selected model first, fallbacks deduped', () => {
  const r = resolveProvider({ provider: 'anthropic', anthropicModel: 'claude-sonnet-5', anthropicApiKey: 'k' });
  assert.equal(r.models[0], 'claude-sonnet-5');
  assert.equal(new Set(r.models).size, r.models.length);
  assert.equal(r.apiKey, 'k');
  assert.equal(r.needsKey, true);
});

test('modelSetting: writes to the current provider’s own field', () => {
  assert.deepEqual(modelSetting({ provider: 'openai' }, 'gpt-5'), { openaiModel: 'gpt-5' });
  assert.deepEqual(modelSetting({ provider: 'gemini' }, ' gemini-2.5-pro '), { genModel: 'gemini-2.5-pro' });
  assert.equal(modelSetting({ provider: 'openai' }, '  '), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/config.test.js`
Expected: FAIL — `resolveProvider is not a function` / `PROVIDERS.anthropic` undefined.

- [ ] **Step 3: Implement** — replace `src/main/config.js`

```js
'use strict';

const gemini = require('./gemini');
const openaiCompat = require('./openaiCompat');
const anthropic = require('./anthropic');

// Answer Provider registry.
// type: 'openai'    → goes through openaiCompat.js (OpenAI-compatible Chat Completions)
//       'gemini'    → goes through gemini.js
//       'anthropic' → goes through anthropic.js
// list: how models.js lists this provider's models (see models.js).
// models: curated list shown in the model picker when the live list can't be fetched.
// keyField/modelField/baseURLField point to field names in settings.js.
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    type: 'openai',
    list: 'openai-compat',
    baseURL: 'https://api.deepseek.com/chat/completions',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    defaultModel: 'deepseek-chat',
    fallbacks: ['deepseek-v4-flash'],
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'],
  },
  openai: {
    label: 'OpenAI',
    type: 'openai',
    list: 'openai',
    baseURL: 'https://api.openai.com/v1/chat/completions',
    keyField: 'openaiApiKey',
    modelField: 'openaiModel',
    defaultModel: 'gpt-4o-mini',
    fallbacks: ['gpt-4o'],
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini'],
  },
  ollama: {
    label: 'Ollama (local)',
    type: 'openai',
    list: 'openai-compat',
    baseURL: 'http://localhost:11434/v1/chat/completions',
    baseURLField: 'ollamaBaseURL',
    keyField: null, // Local, no Key needed
    modelField: 'ollamaModel',
    defaultModel: 'llama3.1',
    fallbacks: [],
    models: ['llama3.1'],
  },
  gemini: {
    label: 'Gemini',
    type: 'gemini',
    list: 'gemini',
    keyField: 'geminiApiKey',
    modelField: 'genModel',
    defaultModel: 'gemini-2.5-flash',
    fallbacks: ['gemini-2.0-flash'],
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  },
  anthropic: {
    label: 'Anthropic',
    type: 'anthropic',
    list: 'anthropic',
    keyField: 'anthropicApiKey',
    modelField: 'anthropicModel',
    defaultModel: 'claude-opus-5',
    fallbacks: ['claude-sonnet-5'],
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  },
};

const STREAMS = {
  openai: openaiCompat.generateAnswerStream,
  gemini: gemini.generateAnswerStream,
  anthropic: anthropic.generateAnswerStream,
};

function providerId(s) {
  return s.provider && PROVIDERS[s.provider] ? s.provider : 'gemini';
}

// Resolve for the current Provider: stream impl / Key / baseURL / model chain
function resolveProvider(s) {
  const id = providerId(s);
  const p = PROVIDERS[id];
  const model = ((s[p.modelField] || '') + '').trim() || p.defaultModel;
  const models = [model, ...(p.fallbacks || [])].filter((m, i, a) => a.indexOf(m) === i);
  return {
    id,
    label: p.label,
    type: p.type,
    needsKey: !!p.keyField,
    apiKey: p.keyField ? s[p.keyField] || '' : '',
    baseURL: p.baseURLField ? s[p.baseURLField] || p.baseURL : p.baseURL,
    models,
    streamFn: STREAMS[p.type],
  };
}

// The settings partial that stores `model` as the current provider's model (null for a blank model)
function modelSetting(s, model) {
  const m = ((model || '') + '').trim();
  if (!m) return null;
  return { [PROVIDERS[providerId(s)].modelField]: m };
}

module.exports = { PROVIDERS, resolveProvider, modelSetting };
```

`src/main/gemini.js` last line → `module.exports = { generateAnswerStream, BASE };`

`src/main/settings.js` DEFAULTS — change the provider comment and add after `ollamaModel`:

```js
  // Answer Provider: deepseek / gemini / openai / ollama / anthropic
  ...
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: 'claude-opus-5',
```

Also change the `genModel` comment to: `// Gemini model (chosen in the main window's model picker)`.

`src/main/main.js`:
- Delete lines 20–41 (`require('./gemini')`, `require('./openaiCompat')`, the `PROVIDERS` import and the local `resolveProvider`). Replace with:

```js
const { resolveProvider } = require('./config');
```

  (Keep `const prompt = require('./prompt');`.) Grep afterwards: `grep -n "gemini\.\|openaiCompat\.\|PROVIDERS" src/main/main.js` must print nothing.
- Replace the token-budget block (comment + `maxOutputTokens` + `extractTokens`, currently ~lines 336–349) with:

```js
  // Output token ceiling.
  // - OpenAI-compatible providers (including DeepSeek/Ollama) may be
  //   "reasoning models": max_tokens must also cover the hidden thinking
  //   chain, and too small a budget leaves the answer empty, so this is
  //   generous and answer length is controlled by the prompt instead (the
  //   thinking chain is never shown to the user).
  // - Anthropic: same reason — thinking is on by default on current Claude
  //   models and counts against max_tokens.
  // - Gemini already has thinking disabled (thinkingBudget=0), so this can be
  //   tightened against the character cap as a length backstop.
  const maxChars = currentSettings.maxChars || 500;
  const lang = currentSettings.answerLanguage || 'auto';
  const perChar = lang === 'en' ? 0.5 : 1.1;
  const BUDGETS = { openai: [4096, 1024], anthropic: [8192, 2048] };
  const [maxOutputTokens, extractTokens] = BUDGETS[prov.type] || [
    Math.min(4096, Math.max(160, Math.ceil(maxChars * perChar * 1.15))),
    80,
  ];
```

Docs:
- `.env.example`: add `ANTHROPIC_API_KEY=` after `OPENAI_API_KEY=`.
- `README.md`: add Anthropic everywhere providers are listed — line 7 badge (`DeepSeek%20%7C%20Gemini%20%7C%20OpenAI%20%7C%20Anthropic%20%7C%20Ollama`), line 11, line 39, line 53 (`DeepSeek, Gemini, OpenAI, Anthropic, or local Ollama — pick the model from the main window`), line 61 (add `/ [Anthropic](https://console.anthropic.com/settings/keys)`), the file tree (`anthropic.js         Anthropic Messages API (SSE)` after `gemini.js`, and `models.js           model picker lists (live + curated fallback)`), line 171 (Chinese section: `DeepSeek / Gemini / OpenAI / Anthropic / Ollama`).
- `package.json`: description `(DeepSeek/Gemini/OpenAI/Anthropic/Ollama)`, add keyword `"anthropic"` after `"openai"`.
- `CHANGELOG.md` under `## [Unreleased]` → `### Added`, first bullet:

```md
- **Anthropic (Claude) provider and a model picker.** Choose the provider in Settings (now including Anthropic), and the model from the new **Model** dropdown in the top bar. The list comes live from the provider's API (OpenAI, Gemini, Anthropic, DeepSeek, Ollama) and falls back to a built-in list when there is no key or the provider can't be reached; ↻ refreshes it. Each provider remembers its own last model. The model text fields were removed from Settings.
```

  and under `### Fixed`: `- The first-run prompt to configure API keys now checks the selected provider's key instead of always asking for a Gemini key.`

- [ ] **Step 4: Run to verify pass**

Run: `npm test && npm run lint && npx prettier --write src test README.md CHANGELOG.md && npm run format:check`
Expected: all PASS. (`test/settings.test.js` still passes — DEFAULTS only gained fields.)

- [ ] **Step 5: Commit**

```bash
git add -A src/main test/config.test.js .env.example README.md package.json CHANGELOG.md
git commit -m "feat: register Anthropic provider; move resolveProvider into config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Model listing (`models.js`)

**Files:**
- Create: `src/main/models.js`
- Test: `test/models.test.js` (new)

**Interfaces:**
- Consumes: `PROVIDERS`, `resolveProvider` (Task 2); `gemini.BASE` (Task 2); `anthropic.MODELS_URL`, `anthropic.API_VERSION` (Task 1).
- Produces:
  - `listModels(settings, { force = false, fetchFn = fetch } = {}) → Promise<{ provider: string, current: string, models: string[], source: 'live' | 'fallback', missingKey: boolean, error?: string }>` — never rejects.
  - `parseModelList(kind, json) → string[]`, `mergeModels(ids, current) → string[]`, `listRequest(prov, kind) → { url, headers }`, `clearCache()` (tests).

- [ ] **Step 1: Write the failing tests** — `test/models.test.js`

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseModelList, mergeModels, listRequest, listModels, clearCache } = require('../src/main/models');
const { PROVIDERS, resolveProvider } = require('../src/main/config');

test('parseModelList(openai): keeps chat models only, sorted', () => {
  const json = {
    data: [
      { id: 'gpt-4o' },
      { id: 'text-embedding-3-small' },
      { id: 'whisper-1' },
      { id: 'o3-mini' },
      { id: 'gpt-4o-mini-tts' },
      { id: 'dall-e-3' },
      { id: 'gpt-4o-realtime-preview' },
      { id: 'gpt-4.1' },
    ],
  };
  assert.deepEqual(parseModelList('openai', json), ['gpt-4.1', 'gpt-4o', 'o3-mini']);
});

test('parseModelList(gemini): generateContent models, prefix stripped, sorted', () => {
  const json = {
    models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
    ],
  };
  assert.deepEqual(parseModelList('gemini', json), ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('parseModelList(anthropic): keeps API order (newest first)', () => {
  const json = { data: [{ id: 'claude-opus-5', type: 'model' }, { id: 'claude-sonnet-5' }, { id: 'claude-haiku-4-5' }], has_more: false };
  assert.deepEqual(parseModelList('anthropic', json), ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
});

test('parseModelList(openai-compat): every id, sorted; garbage tolerated', () => {
  assert.deepEqual(parseModelList('openai-compat', { data: [{ id: 'qwen2.5' }, { id: 'llama3.1' }, {}] }), ['llama3.1', 'qwen2.5']);
  assert.deepEqual(parseModelList('openai-compat', null), []);
  assert.deepEqual(parseModelList('gemini', {}), []);
});

test('mergeModels: a saved model missing from the list is kept, first', () => {
  assert.deepEqual(mergeModels(['a', 'b'], 'my-finetune'), ['my-finetune', 'a', 'b']);
  assert.deepEqual(mergeModels(['a', 'b'], 'b'), ['a', 'b']);
});

test('listRequest: derives list URLs and auth per provider', () => {
  const ds = listRequest(resolveProvider({ provider: 'deepseek', deepseekApiKey: 'k' }), 'openai-compat');
  assert.equal(ds.url, 'https://api.deepseek.com/models');
  assert.equal(ds.headers.Authorization, 'Bearer k');

  const ol = listRequest(resolveProvider({ provider: 'ollama', ollamaBaseURL: 'http://10.0.0.5:11434/v1/chat/completions' }), 'openai-compat');
  assert.equal(ol.url, 'http://10.0.0.5:11434/v1/models');
  assert.equal(ol.headers.Authorization, undefined);

  const an = listRequest(resolveProvider({ provider: 'anthropic', anthropicApiKey: 'k' }), 'anthropic');
  assert.equal(an.url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(an.headers['x-api-key'], 'k');
  assert.equal(an.headers['anthropic-version'], '2023-06-01');

  const ge = listRequest(resolveProvider({ provider: 'gemini', geminiApiKey: 'k' }), 'gemini');
  assert.match(ge.url, /\/v1beta\/models\?pageSize=1000&key=k$/);
});

const okJson = (obj) => async () => new Response(JSON.stringify(obj), { status: 200 });

test('listModels: live list merged with the saved model; cached until forced', async () => {
  clearCache();
  let calls = 0;
  const fetchFn = async (...a) => {
    calls++;
    return okJson({ data: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }] })(...a);
  };
  const s = { provider: 'anthropic', anthropicApiKey: 'k', anthropicModel: 'claude-custom' };
  const r = await listModels(s, { fetchFn });
  assert.equal(r.source, 'live');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.current, 'claude-custom');
  assert.deepEqual(r.models, ['claude-custom', 'claude-sonnet-5', 'claude-opus-5']);
  await listModels(s, { fetchFn });
  assert.equal(calls, 1, 'second call served from cache');
  await listModels(s, { fetchFn, force: true });
  assert.equal(calls, 2, 'force bypasses the cache');
});

test('listModels: a different key is a different cache entry', async () => {
  clearCache();
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 });
  };
  await listModels({ provider: 'openai', openaiApiKey: 'a' }, { fetchFn });
  await listModels({ provider: 'openai', openaiApiKey: 'b' }, { fetchFn });
  assert.equal(calls, 2);
});

test('listModels: no key → curated fallback, no request, missingKey', async () => {
  clearCache();
  let called = false;
  const r = await listModels({ provider: 'openai', openaiApiKey: '' }, {
    fetchFn: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(r.source, 'fallback');
  assert.equal(r.missingKey, true);
  assert.deepEqual(r.models, PROVIDERS.openai.models);
});

test('listModels: Ollama needs no key and is never missingKey', async () => {
  clearCache();
  const r = await listModels({ provider: 'ollama' }, { fetchFn: okJson({ data: [{ id: 'qwen2.5' }] }) });
  assert.equal(r.missingKey, false);
  assert.deepEqual(r.models, ['llama3.1', 'qwen2.5']);
});

test('listModels: network error / non-ok / empty list → fallback with a key-free error', async () => {
  for (const fetchFn of [
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => new Response('bad key', { status: 401 }),
    okJson({ models: [] }),
  ]) {
    clearCache();
    const r = await listModels({ provider: 'gemini', geminiApiKey: 'SECRET' }, { fetchFn });
    assert.equal(r.source, 'fallback');
    assert.deepEqual(r.models, PROVIDERS.gemini.models);
    assert.ok(r.error);
    assert.ok(!r.error.includes('SECRET'), 'error must not leak the key');
  }
});

test('listModels: failures are not cached', async () => {
  clearCache();
  const s = { provider: 'openai', openaiApiKey: 'k' };
  await listModels(s, { fetchFn: async () => new Response('', { status: 503 }) });
  const r = await listModels(s, { fetchFn: okJson({ data: [{ id: 'gpt-4o' }] }) });
  assert.equal(r.source, 'live');
});

test('listModels: request carries a timeout signal', async () => {
  clearCache();
  let signal;
  await listModels({ provider: 'openai', openaiApiKey: 'k' }, {
    fetchFn: async (_u, init) => {
      signal = init.signal;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 });
    },
  });
  assert.ok(signal instanceof AbortSignal);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/models.test.js`
Expected: FAIL — `Cannot find module '../src/main/models'`.

- [ ] **Step 3: Implement** — `src/main/models.js`

```js
'use strict';

// Lists the models a provider offers, for the main-window model picker.
// Asks the provider's API live; with no key, on a network error, or on an empty
// response it falls back to the curated list in config.js so the picker is never empty.
const { PROVIDERS, resolveProvider } = require('./config');
const gemini = require('./gemini');
const anthropic = require('./anthropic');

const TIMEOUT_MS = 5000;
// Non-chat OpenAI models that /v1/models also returns
const OPENAI_EXCLUDE = /(embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|search|moderation|instruct)/;

// Successful live lists, keyed by provider + key + base URL (a new key or URL refetches)
const cache = new Map();

const ids = (arr) => (Array.isArray(arr) ? arr : []).map((m) => m && m.id).filter((id) => typeof id === 'string' && id);
const sorted = (arr) => [...new Set(arr)].sort();

// Turns a list-endpoint response into model IDs. Exported for use by unit tests.
function parseModelList(kind, json) {
  switch (kind) {
    case 'openai':
      return sorted(ids(json?.data).filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !OPENAI_EXCLUDE.test(id)));
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
    return { url: `${gemini.BASE}/models?pageSize=1000&key=${encodeURIComponent(prov.apiKey)}`, headers: {} };
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
  const fallback = (error) => ({ ...base, models: mergeModels(def.models, current), source: 'fallback', error });

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
      return fallback(String(msg || 'request failed').split(prov.apiKey || '\0').join('***'));
    }
  }
  return { ...base, models: mergeModels(list, current), source: 'live' };
}

function clearCache() {
  cache.clear();
}

module.exports = { listModels, parseModelList, mergeModels, listRequest, clearCache };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/models.test.js && npm test && npm run lint && npx prettier --write src/main/models.js test/models.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/models.js test/models.test.js
git commit -m "feat: list provider models live with a curated fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: IPC — `list-models`, `select-model`

**Files:**
- Modify: `src/main/main.js` (imports + two handlers next to `get-settings`/`save-settings`, ~line 212)
- Modify: `src/main/preload.js` (Settings section)

**Interfaces:**
- Consumes: `listModels` (Task 3), `modelSetting` (Task 2).
- Produces (renderer `window.api`):
  - `listModels({ force?: boolean }) → Promise<listModels result>` (Task 3 shape)
  - `selectModel(model: string) → Promise<settings>` — the full saved settings object.

No unit test: these are two-line Electron glue handlers over tested functions; covered by the Task 5 run-through.

- [ ] **Step 1: Implement** — `src/main/main.js`

Change the config import to `const { resolveProvider, modelSetting } = require('./config');` and add `const models = require('./models');` beside it. After the `save-settings` handler:

```js
// Model picker: list the current provider's models / store the chosen one as that provider's model
ipcMain.handle('list-models', (_e, opts) => models.listModels(currentSettings, { force: !!(opts && opts.force) }));

ipcMain.handle('select-model', (_e, model) => {
  const partial = modelSetting(currentSettings, model);
  if (partial) currentSettings = settingsStore.save(partial);
  return currentSettings;
});
```

`src/main/preload.js`, after `saveSettings`:

```js
  listModels: (opts) => ipcRenderer.invoke('list-models', opts),
  selectModel: (model) => ipcRenderer.invoke('select-model', model),
```

- [ ] **Step 2: Verify**

Run: `npm test && npm run lint && npx prettier --check src/main`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/main.js src/main/preload.js
git commit -m "feat: expose model listing and selection over IPC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Renderer — top-bar Model picker, Settings dialog

**Files:**
- Modify: `src/renderer/index.html` (top bar after `langSelect` label ~line 67; Settings provider/model block ~lines 256–304)
- Modify: `src/renderer/app.js` (`openSettings`/`saveSettings` ~585–633, `bindEvents` ~636, `init` ~770)
- Modify: `src/renderer/styles.css` (after `.field > span`)
- Test: `test/renderer-ids.test.js` (new)

**Interfaces:**
- Consumes: `window.api.listModels`, `window.api.selectModel` (Task 4).
- Produces: `loadModels(force = false) → Promise<result | null>` in `app.js`.

- [ ] **Step 1: Write the failing test** — `test/renderer-ids.test.js`

Guards against the main risk of this task: `app.js` still referencing a removed input (e.g. `setOpenaiModel`), which throws on `openSettings()` at runtime.

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

test('every $("id") used by app.js exists in index.html', () => {
  const js = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `ids used in app.js but missing from index.html`);
});

test('model picker and Anthropic settings are present; per-provider model inputs are gone', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  for (const id of ['modelSelect', 'modelRefresh', 'setAnthropic']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<option value="anthropic">Anthropic<\/option>/);
  for (const id of ['setModel', 'setOpenaiModel', 'setDeepseekModel', 'setOllamaModel']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/renderer-ids.test.js`
Expected: first test PASSES (baseline sanity — if it fails, fix the pre-existing mismatch before continuing and note it in the commit); second FAILS (`modelSelect` missing).

- [ ] **Step 3: Implement HTML** — `src/renderer/index.html`

Top bar, directly after the `Transcript language` `</label>` and before `toggleBtn`:

```html
        <label class="field">
          <span>Model</span>
          <select id="modelSelect" class="model-select" disabled>
            <option>Loading…</option>
          </select>
        </label>
        <button id="modelRefresh" class="btn icon-btn" title="Refresh model list">↻</button>
```

Settings dialog:
- Provider select: add `<option value="anthropic">Anthropic</option>` after OpenAI.
- Delete the four model `<label class="setting">` blocks: `setDeepseekModel`, `setModel` (Gemini model ID), `setOpenaiModel`, and — inside the Ollama `setting-row` — `setOllamaModel`. Replace the now single-child Ollama `<div class="setting-row">…</div>` with just its `setOllamaURL` label (no row wrapper).
- After the OpenAI API Key label, add:

```html
          <label class="setting">
            <span>Anthropic API Key</span>
            <input type="password" id="setAnthropic" placeholder="sk-ant-…" />
          </label>
```

- Under the provider select add a hint so the moved field is discoverable — change its span to `<span>Answer provider <em class="muted">(pick the model in the top bar)</em></span>`. Check `styles.css` for an existing muted/hint class (`grep -n "muted" src/renderer/styles.css`); if `.muted` as a class doesn't exist, add `.setting em { font-style: normal; color: var(--muted); }` instead and drop the class.

`src/renderer/styles.css`, after `.field > span { … }`:

```css
.model-select {
  min-width: 190px;
  max-width: 240px;
}
```

- [ ] **Step 4: Implement JS** — `src/renderer/app.js`

`openSettings()`: delete the `setDeepseekModel`, `setModel`, `setOpenaiModel`, `setOllamaModel` lines; add after `setOpenai`:

```js
  $('setAnthropic').value = s.anthropicApiKey || '';
```

`saveSettings()`: delete the `deepseekModel`, `genModel`, `openaiModel`, `ollamaModel` entries from `partial`; add `anthropicApiKey: $('setAnthropic').value.trim(),` after `openaiApiKey`. After `state.settings = await window.api.saveSettings(partial);` add `loadModels();` (provider or key may have changed; not awaited so the modal closes immediately).

Add a new section above `// ---------------- Settings modal ----------------`:

```js
// ---------------- Model picker ----------------
let modelListSeq = 0;

// Fills the top-bar model dropdown for the current provider. A newer call (e.g. after
// switching provider in Settings) supersedes an older one still waiting on the network.
async function loadModels(force = false) {
  const seq = ++modelListSeq;
  const sel = $('modelSelect');
  sel.disabled = true;
  let r;
  try {
    r = await window.api.listModels({ force });
  } catch (e) {
    if (seq === modelListSeq) toast('Couldn’t load models: ' + e.message, true);
    return null;
  }
  if (seq !== modelListSeq) return null;
  sel.textContent = '';
  for (const id of r.models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  }
  sel.value = r.current;
  sel.disabled = false;
  sel.title =
    r.source === 'live' ? `${r.models.length} models available` : `Built-in list — ${r.error}`;
  if (force) {
    if (r.source === 'live') toast('Model list refreshed');
    else toast(`Couldn’t refresh models: ${r.error}`, true);
  }
  return r;
}
```

`bindEvents()`, next to the `langSelect` handler:

```js
  // Model picker: saved as the current provider's model; takes effect on the next answer
  $('modelSelect').onchange = async (e) => {
    state.settings = await window.api.selectModel(e.target.value);
    toast(`Model → ${e.target.value}`);
  };
  $('modelRefresh').onclick = () => loadModels(true);
```

`init()`: replace

```js
  if (!state.settings.deepgramApiKey || !state.settings.geminiApiKey) {
```

with

```js
  const modelList = await loadModels();
  if (!state.settings.deepgramApiKey || (modelList && modelList.missingKey)) {
```

- [ ] **Step 5: Run tests**

Run: `npm test && npm run lint && npx prettier --write src/renderer test/renderer-ids.test.js && npm run format:check`
Expected: all PASS, including `renderer-scripts.test.js` (no new top-level name collides — `loadModels`/`modelListSeq` must not already exist in `deepgram.js`: `grep -n "loadModels\|modelListSeq" src/renderer/*.js`).

- [ ] **Step 6: Commit**

```bash
git add src/renderer test/renderer-ids.test.js
git commit -m "feat: model picker in the top bar; Anthropic key in Settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Run the app and check by hand** (use the `run` skill; if Electron fails to start, see memory: run `node node_modules/electron/install.js`)

Check each, and report which ones were actually verified vs. not possible (e.g. no Anthropic key available):
1. Top bar shows **Model** dropdown + ↻; with the current provider it lists models (tooltip says "N models available" with a valid key, "Built-in list — …" without).
2. Pick a different model → toast; reopen app → still selected.
3. Settings → provider **Anthropic**, enter key, Save → dropdown repopulates with Claude models; generate an answer → streams.
4. Switch provider back to Gemini → Gemini models, previously chosen Gemini model still selected.
5. Provider Ollama with Ollama not running → built-in list, ↻ shows the error toast, app responsive.
6. Stale-response guard: Save Settings twice quickly with different providers → dropdown ends on the last provider's models.
7. Settings dialog: no model text fields; Ollama base URL still editable; no console errors (`npm run dev`).

---

## Self-review notes

- Spec coverage: provider in Settings (Task 5 + Task 2 option), model dropdown in main window (Tasks 3–5), OpenAI/Gemini/Anthropic support (Tasks 1–2; OpenAI/Gemini already existed), live+fallback list (Task 3), per-provider memory (Task 2 `modelSetting`, Task 4), refresh (Task 5), tests (every task).
- Names used across tasks: `resolveProvider`, `modelSetting`, `PROVIDERS[*].list/models`, `listModels`, `clearCache`, `MODELS_URL`, `API_VERSION`, `gemini.BASE`, `window.api.listModels/selectModel`, `loadModels`, `missingKey` — consistent.
