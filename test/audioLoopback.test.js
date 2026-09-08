'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FEATURE_SWITCH, buildLoopbackFeatures } = require('../src/main/audioLoopback');

test('FEATURE_SWITCH is the Chromium enable-features switch', () => {
  assert.strictEqual(FEATURE_SWITCH, 'enable-features');
});

test('darwin gets both macOS loopback flags', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'darwin' }),
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
});

test('linux gets the PulseAudio loopback flag', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'linux' }),
    'PulseaudioLoopbackForScreenShare',
  );
});

test('win32 needs no flags (loopback is native there)', () => {
  assert.strictEqual(buildLoopbackFeatures({ platform: 'win32' }), null);
});

test('an unknown platform needs no flags', () => {
  assert.strictEqual(buildLoopbackFeatures({ platform: 'freebsd' }), null);
});

test('an existing enable-features value is preserved, required flags appended', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'darwin', existing: 'SomeOtherFeature' }),
    'SomeOtherFeature,MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
});

test('a flag that is already present is not duplicated', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'darwin', existing: 'MacLoopbackAudioForScreenShare' }),
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
});

test('empty, whitespace and absent existing values produce no stray separators', () => {
  const expected = 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride';
  assert.strictEqual(buildLoopbackFeatures({ platform: 'darwin', existing: '' }), expected);
  assert.strictEqual(buildLoopbackFeatures({ platform: 'darwin', existing: '  ,  ' }), expected);
  assert.strictEqual(buildLoopbackFeatures({ platform: 'darwin', existing: undefined }), expected);
});

test('surrounding whitespace in an existing value is trimmed', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'darwin', existing: ' A , B ' }),
    'A,B,MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
});

test('called with no arguments it returns null instead of throwing', () => {
  assert.strictEqual(buildLoopbackFeatures(), null);
});
