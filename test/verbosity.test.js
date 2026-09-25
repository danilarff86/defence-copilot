'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LEVELS, DEFAULT_LEVEL, lengthLevel, levelFromMaxChars } = require('../src/main/verbosity');

test('LEVELS: four steps from terse to detailed, each longer than the last', () => {
  assert.deepEqual(
    LEVELS.map((l) => l.name),
    ['Terse', 'Brief', 'Standard', 'Detailed'],
  );
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(LEVELS[i].maxChars > LEVELS[i - 1].maxChars, `${LEVELS[i].name} cap grows`);
    assert.ok(LEVELS[i].sentences[1] > LEVELS[i - 1].sentences[1], `${LEVELS[i].name} range grows`);
  }
});

test('DEFAULT_LEVEL: Standard keeps the previous 3-8 sentence / 1200 char behaviour', () => {
  assert.deepEqual(LEVELS[DEFAULT_LEVEL], {
    name: 'Standard',
    sentences: [3, 8],
    maxChars: 1200,
  });
});

test('lengthLevel: returns the level for a valid index', () => {
  assert.strictEqual(lengthLevel(0), LEVELS[0]);
  assert.strictEqual(lengthLevel(3), LEVELS[3]);
});

test('lengthLevel: out-of-range or garbage values fall back safely', () => {
  assert.strictEqual(lengthLevel(-1), LEVELS[0]);
  assert.strictEqual(lengthLevel(99), LEVELS[3]);
  assert.strictEqual(lengthLevel(undefined), LEVELS[DEFAULT_LEVEL]);
  assert.strictEqual(lengthLevel('x'), LEVELS[DEFAULT_LEVEL]);
  assert.strictEqual(lengthLevel(1.6), LEVELS[2], 'fractional values round');
});

test('levelFromMaxChars: buckets an old character cap to the nearest level', () => {
  assert.strictEqual(levelFromMaxChars(200), 0);
  assert.strictEqual(levelFromMaxChars(400), 0);
  assert.strictEqual(levelFromMaxChars(500), 1);
  assert.strictEqual(levelFromMaxChars(900), 1);
  assert.strictEqual(levelFromMaxChars(1200), 2);
  assert.strictEqual(levelFromMaxChars(1600), 2);
  assert.strictEqual(levelFromMaxChars(2000), 3);
  assert.strictEqual(levelFromMaxChars(undefined), DEFAULT_LEVEL);
});

test('the renderer mirror of the levels matches LEVELS', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const m = js.match(/const ANSWER_LENGTHS = (\[[\s\S]*?\]);/);
  assert.ok(m, 'app.js declares ANSWER_LENGTHS');
  assert.deepEqual(
    vm.runInNewContext(m[1]),
    LEVELS.map(({ name, maxChars }) => ({ name, maxChars })),
  );
});
