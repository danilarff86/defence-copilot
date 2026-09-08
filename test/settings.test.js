'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, DEFAULTS, SETTINGS_VERSION } = require('../src/main/settings');

test('DEFAULTS: answer length is the academic-prose budget', () => {
  assert.strictEqual(DEFAULTS.maxChars, 1200);
  assert.strictEqual(DEFAULTS.schemaVersion, SETTINGS_VERSION);
});

test('DEFAULTS: the sentence pause is long enough to survive a thinking pause', () => {
  assert.strictEqual(DEFAULTS.sttPauseMs, 900);
});

test('migrate: a v1 file still on the old 500 default is lifted to the new default', () => {
  const out = migrate({ maxChars: 500, provider: 'gemini' });
  assert.strictEqual(out.maxChars, 1200);
  assert.strictEqual(out.schemaVersion, SETTINGS_VERSION);
  assert.strictEqual(out.provider, 'gemini', 'unrelated settings are preserved');
});

test('migrate: a v1 file with a user-chosen length keeps it', () => {
  assert.strictEqual(migrate({ maxChars: 800 }).maxChars, 800);
  assert.strictEqual(migrate({ maxChars: 200 }).maxChars, 200);
});

test('migrate: an already-migrated file is returned untouched', () => {
  const saved = { maxChars: 500, schemaVersion: SETTINGS_VERSION };
  assert.strictEqual(migrate(saved).maxChars, 500, 'a deliberate 500 set after migrating survives');
});

test('migrate: does not mutate its input', () => {
  const saved = { maxChars: 500 };
  migrate(saved);
  assert.strictEqual(saved.maxChars, 500);
  assert.strictEqual(saved.schemaVersion, undefined);
});
