'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseModelList,
  mergeModels,
  listRequest,
  listModels,
  clearCache,
} = require('../src/main/models');
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
      {
        name: 'models/gemini-2.5-pro',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
    ],
  };
  assert.deepEqual(parseModelList('gemini', json), ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('parseModelList(anthropic): keeps API order (newest first)', () => {
  const json = {
    data: [
      { id: 'claude-opus-5', type: 'model' },
      { id: 'claude-sonnet-5' },
      { id: 'claude-haiku-4-5' },
    ],
    has_more: false,
  };
  assert.deepEqual(parseModelList('anthropic', json), [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ]);
});

test('parseModelList(openai-compat): every id, sorted; garbage tolerated', () => {
  assert.deepEqual(
    parseModelList('openai-compat', { data: [{ id: 'qwen2.5' }, { id: 'llama3.1' }, {}] }),
    ['llama3.1', 'qwen2.5'],
  );
  assert.deepEqual(parseModelList('openai-compat', null), []);
  assert.deepEqual(parseModelList('gemini', {}), []);
});

test('mergeModels: a saved model missing from the list is kept, first', () => {
  assert.deepEqual(mergeModels(['a', 'b'], 'my-finetune'), ['my-finetune', 'a', 'b']);
  assert.deepEqual(mergeModels(['a', 'b'], 'b'), ['a', 'b']);
});

test('listRequest: derives list URLs and auth per provider', () => {
  const ds = listRequest(
    resolveProvider({ provider: 'deepseek', deepseekApiKey: 'k' }),
    'openai-compat',
  );
  assert.equal(ds.url, 'https://api.deepseek.com/models');
  assert.equal(ds.headers.Authorization, 'Bearer k');

  const ol = listRequest(
    resolveProvider({
      provider: 'ollama',
      ollamaBaseURL: 'http://10.0.0.5:11434/v1/chat/completions',
    }),
    'openai-compat',
  );
  assert.equal(ol.url, 'http://10.0.0.5:11434/v1/models');
  assert.equal(ol.headers.Authorization, undefined);

  const an = listRequest(
    resolveProvider({ provider: 'anthropic', anthropicApiKey: 'k' }),
    'anthropic',
  );
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
  const r = await listModels(
    { provider: 'openai', openaiApiKey: '' },
    {
      fetchFn: async () => {
        called = true;
      },
    },
  );
  assert.equal(called, false);
  assert.equal(r.source, 'fallback');
  assert.equal(r.missingKey, true);
  assert.deepEqual(r.models, PROVIDERS.openai.models);
});

test('listModels: Ollama needs no key and is never missingKey', async () => {
  clearCache();
  const r = await listModels(
    { provider: 'ollama' },
    { fetchFn: okJson({ data: [{ id: 'qwen2.5' }] }) },
  );
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
  await listModels(
    { provider: 'openai', openaiApiKey: 'k' },
    {
      fetchFn: async (_u, init) => {
        signal = init.signal;
        return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 });
      },
    },
  );
  assert.ok(signal instanceof AbortSignal);
});
