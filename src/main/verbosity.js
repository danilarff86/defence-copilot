'use strict';

// Answer-length levels behind the slider in the Answer card. Each level bounds
// both the sentence count the prompt asks for and the hard character cap.
// The renderer keeps a mirror of the names and caps (ANSWER_LENGTHS in
// src/renderer/app.js); test/verbosity.test.js checks the two agree.
const LEVELS = [
  { name: 'Terse', sentences: [1, 2], maxChars: 300 },
  { name: 'Brief', sentences: [2, 4], maxChars: 600 },
  { name: 'Standard', sentences: [3, 8], maxChars: 1200 },
  { name: 'Detailed', sentences: [6, 12], maxChars: 2000 },
];

const DEFAULT_LEVEL = 2;

function lengthLevel(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return LEVELS[DEFAULT_LEVEL];
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, n))];
}

// Maps a pre-slider `maxChars` setting onto the closest level (settings migration).
function levelFromMaxChars(maxChars) {
  if (typeof maxChars !== 'number') return DEFAULT_LEVEL;
  if (maxChars <= 400) return 0;
  if (maxChars <= 900) return 1;
  if (maxChars <= 1600) return 2;
  return 3;
}

module.exports = { LEVELS, DEFAULT_LEVEL, lengthLevel, levelFromMaxChars };
