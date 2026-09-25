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
    if (p.keyField)
      assert.ok(p.keyField in DEFAULTS, `${id}: ${p.keyField} has a settings default`);
    assert.ok(
      ['openai', 'openai-compat', 'gemini', 'anthropic'].includes(p.list),
      `${id}: list kind`,
    );
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
  const r = resolveProvider({
    provider: 'anthropic',
    anthropicModel: 'claude-sonnet-5',
    anthropicApiKey: 'k',
  });
  assert.equal(r.models[0], 'claude-sonnet-5');
  assert.equal(new Set(r.models).size, r.models.length);
  assert.equal(r.apiKey, 'k');
  assert.equal(r.needsKey, true);
});

test('modelSetting: writes to the current provider’s own field', () => {
  assert.deepEqual(modelSetting({ provider: 'openai' }, 'gpt-5'), { openaiModel: 'gpt-5' });
  assert.deepEqual(modelSetting({ provider: 'gemini' }, ' gemini-2.5-pro '), {
    genModel: 'gemini-2.5-pro',
  });
  assert.equal(modelSetting({ provider: 'openai' }, '  '), null);
});

test('tokenBudgets: thinking providers get room for thinking; Gemini is capped by answer length', () => {
  const { tokenBudgets } = require('../src/main/config');
  // Claude thinking counts against max_tokens even for the one-line extraction call
  assert.deepEqual(tokenBudgets('anthropic', { maxChars: 1200, answerLanguage: 'en' }), {
    answer: 8192,
    extract: 4096,
  });
  assert.deepEqual(tokenBudgets('openai', { maxChars: 1200, answerLanguage: 'en' }), {
    answer: 4096,
    extract: 1024,
  });
  // Gemini: thinking disabled, so the ceiling tracks the character cap
  assert.deepEqual(tokenBudgets('gemini', { maxChars: 1200, answerLanguage: 'en' }), {
    answer: Math.ceil(1200 * 0.5 * 1.15),
    extract: 80,
  });
  assert.equal(tokenBudgets('gemini', { maxChars: 100, answerLanguage: 'zh' }).answer, 160);
  assert.equal(tokenBudgets('gemini', { maxChars: 100000, answerLanguage: 'zh' }).answer, 4096);
});
