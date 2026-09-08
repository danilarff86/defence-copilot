'use strict';

// System audio (the interviewer) is captured through getDisplayMedia's loopback path.
// Electron 31.0.1–38.x needs Chromium's feature flag explicitly turned on on
// macOS/Linux, and it must be written into the command line before app ready;
// Electron 39+ already has it built in and needs none of these switches.
// The flag names are taken from alectrocute/electron-audio-loopback (src/config.ts).
const FEATURE_SWITCH = 'enable-features';

const LOOPBACK_FEATURES = {
  // MacSckSystemAudioLoopbackOverride routes loopback through ScreenCaptureKit (macOS 13.2+).
  darwin: ['MacLoopbackAudioForScreenShare', 'MacSckSystemAudioLoopbackOverride'],
  linux: ['PulseaudioLoopbackForScreenShare'],
  // win32 supports loopback natively, no switch needed.
};

// Merge rather than overwrite: keep the enable-features value already on the command line, only adding the switches that are missing.
function buildLoopbackFeatures({ platform, existing } = {}) {
  const required = LOOPBACK_FEATURES[platform];
  if (!required || !required.length) return null;

  const merged = (existing || '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  for (const f of required) {
    if (!merged.includes(f)) merged.push(f);
  }
  return merged.join(',');
}

module.exports = { FEATURE_SWITCH, LOOPBACK_FEATURES, buildLoopbackFeatures };
