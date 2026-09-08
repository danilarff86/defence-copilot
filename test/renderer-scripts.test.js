'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

// The renderer loads its scripts as classic <script> tags, so they all share one
// global scope: a top-level `const` in one file collides with the same name in
// another and the second script fails to parse entirely. ESLint can't see this
// (it lints each file alone), so compile them together the way the browser does.
function scriptsInIndexOrder() {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const names = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 1, 'expected index.html to load several scripts');
  return names;
}

test('renderer scripts share a global scope without colliding', () => {
  const names = scriptsInIndexOrder();
  const combined = names
    .map((n) => `// ---- ${n} ----\n${fs.readFileSync(path.join(RENDERER, n), 'utf8')}`)
    .join('\n');

  // Compile only — this catches early errors such as a duplicate top-level
  // declaration, without executing anything that needs a DOM.
  assert.doesNotThrow(() => new vm.Script(combined), SyntaxError);
});
