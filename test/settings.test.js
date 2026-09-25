'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, DEFAULTS, SETTINGS_VERSION } = require('../src/main/settings');
const { DEFAULT_LEVEL } = require('../src/main/verbosity');

test('DEFAULTS: answer length starts at Standard; the old character cap is gone', () => {
  assert.strictEqual(DEFAULTS.answerLength, DEFAULT_LEVEL);
  assert.ok(!('maxChars' in DEFAULTS));
  assert.strictEqual(DEFAULTS.schemaVersion, SETTINGS_VERSION);
});

test('DEFAULTS: the sentence pause is long enough to survive a thinking pause', () => {
  assert.strictEqual(DEFAULTS.sttPauseMs, 900);
});

test('migrate: a v1 file still on the old 500 default ends up at Standard', () => {
  const out = migrate({ maxChars: 500, provider: 'gemini' });
  assert.strictEqual(out.answerLength, 2);
  assert.ok(!('maxChars' in out));
  assert.strictEqual(out.schemaVersion, SETTINGS_VERSION);
  assert.strictEqual(out.provider, 'gemini', 'unrelated settings are preserved');
});

test('migrate: a user-chosen character cap maps to the nearest length level', () => {
  assert.strictEqual(migrate({ maxChars: 200 }).answerLength, 0);
  assert.strictEqual(migrate({ maxChars: 800 }).answerLength, 1);
  assert.strictEqual(migrate({ maxChars: 500, schemaVersion: 2 }).answerLength, 1);
  assert.strictEqual(migrate({ maxChars: 1200, schemaVersion: 2 }).answerLength, 2);
  assert.strictEqual(migrate({ maxChars: 2000, schemaVersion: 2 }).answerLength, 3);
});

test('migrate: a file without a character cap is left to the default level', () => {
  const out = migrate({ schemaVersion: 2 });
  assert.ok(!('answerLength' in out));
  assert.ok(!('maxChars' in out));
});

test('migrate: an already-migrated file is returned untouched', () => {
  const saved = { answerLength: 0, schemaVersion: SETTINGS_VERSION };
  assert.strictEqual(migrate(saved).answerLength, 0);
});

test('migrate: does not mutate its input', () => {
  const saved = { maxChars: 500 };
  migrate(saved);
  assert.strictEqual(saved.maxChars, 500);
  assert.strictEqual(saved.schemaVersion, undefined);
});
