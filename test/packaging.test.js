'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// extend-info.plist feeds @electron/packager (`make app`); build.mac.extendInfo
// feeds electron-builder (`npm run dist:mac`). They are maintained by hand and
// must not drift: a key present in only one produces an app that captures audio
// when built one way and silently fails when built the other.
function plistUsageKeys() {
  const xml = fs.readFileSync(path.join(ROOT, 'extend-info.plist'), 'utf8');
  return [...xml.matchAll(/<key>(NS\w*UsageDescription)<\/key>/g)].map((m) => m[1]).sort();
}

function builderUsageKeys() {
  const extendInfo = require(path.join(ROOT, 'package.json')).build.mac.extendInfo;
  return Object.keys(extendInfo)
    .filter((k) => /^NS\w*UsageDescription$/.test(k))
    .sort();
}

test('extend-info.plist declares the system-audio usage description', () => {
  assert.ok(
    plistUsageKeys().includes('NSAudioCaptureUsageDescription'),
    'CoreAudio Tap capture fails silently on macOS 14.2+ without this key',
  );
});

test('electron-builder config declares the system-audio usage description', () => {
  assert.ok(
    builderUsageKeys().includes('NSAudioCaptureUsageDescription'),
    'CoreAudio Tap capture fails silently on macOS 14.2+ without this key',
  );
});

test('both packaging paths declare the same usage-description keys', () => {
  assert.deepStrictEqual(plistUsageKeys(), builderUsageKeys());
});

test('every usage description is a non-empty string', () => {
  const extendInfo = require(path.join(ROOT, 'package.json')).build.mac.extendInfo;
  for (const [key, value] of Object.entries(extendInfo)) {
    if (!/^NS\w*UsageDescription$/.test(key)) continue;
    assert.strictEqual(typeof value, 'string', `${key} must be a string`);
    assert.ok(value.trim().length > 0, `${key} must not be empty — macOS shows it in the prompt`);
  }
});
