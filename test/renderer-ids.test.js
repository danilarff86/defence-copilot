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
  for (const id of ['modelSelect', 'modelRefresh', 'setAnthropic'])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<option value="anthropic">Anthropic<\/option>/);
  for (const id of ['setModel', 'setOpenaiModel', 'setDeepseekModel', 'setOllamaModel']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
});

test('answer length slider lives in the Answer card; the Settings char cap is gone', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const card = html.slice(
    html.indexOf('class="card answer-card"'),
    html.indexOf('class="card docs-card"'),
  );
  assert.match(
    card,
    /<input[^>]*type="range"[^>]*id="answerLength"|id="answerLength"[^>]*type="range"/,
  );
  assert.match(card, /id="answerLengthLabel"/);
  assert.doesNotMatch(html, /id="setMaxChars"/);
});
