'use strict';

// Knowledge base: stores the plain text of uploaded/pasted documents and
// splices all of it into the context when answering.
// Persisted to userData/knowledge.json — add/remove/update/clear all write to
// disk, so it survives a restart.
// No vector retrieval: Flash and other large-context models have plenty of
// room, so the interview material is fed in directly.

const fs = require('fs');
const path = require('path');

// The Electron main process has `app`; a plain Node unit test does not — fall back to in-memory mode (no disk writes) automatically.
let app = null;
try {
  app = require('electron').app;
} catch (_e) {
  /* not in electron */
}
const canPersist = () => !!(app && typeof app.getPath === 'function');
const filePath = () => path.join(app.getPath('userData'), 'knowledge.json');

let docs = null; // Lazily loaded: { id, name, text, chars }[]
let seq = 0;

function ensureLoaded() {
  if (docs !== null) return;
  docs = [];
  seq = 0;
  if (!canPersist()) return;
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (Array.isArray(data.docs)) {
      docs = data.docs;
      seq = docs.reduce((m, d) => {
        const n = parseInt(String(d.id).replace(/\D/g, ''), 10) || 0;
        return Math.max(m, n);
      }, 0);
    }
  } catch (_e) {
    // File missing / corrupted → treat as an empty knowledge base
  }
}

function persist() {
  if (!canPersist()) return;
  try {
    fs.writeFileSync(filePath(), JSON.stringify({ docs }, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save knowledge base:', e);
  }
}

function add(name, text) {
  ensureLoaded();
  const clean = (text || '').trim();
  const id = `doc_${++seq}`;
  docs.push({ id, name, text: clean, chars: clean.length });
  persist();
  return summary();
}

// Update a document's name/content (remove-then-re-add also works; this one updates it in place)
function update(id, { name, text } = {}) {
  ensureLoaded();
  const d = docs.find((x) => x.id === id);
  if (d) {
    if (typeof name === 'string') d.name = name;
    if (typeof text === 'string') {
      d.text = text.trim();
      d.chars = d.text.length;
    }
    persist();
  }
  return summary();
}

function remove(id) {
  ensureLoaded();
  docs = docs.filter((d) => d.id !== id);
  persist();
  return summary();
}

function clear() {
  ensureLoaded();
  docs = [];
  persist();
  return summary();
}

function summary() {
  ensureLoaded();
  return docs.map((d) => ({ id: d.id, name: d.name, chars: d.chars }));
}

/**
 * Assemble the document text to inject into the context, truncating it proportionally if it exceeds the cap.
 */
function buildContext(maxChars = 60000) {
  ensureLoaded();
  if (docs.length === 0) return '';
  const blocks = docs.map((d) => `### Material: ${d.name}\n${d.text}`);
  let joined = blocks.join('\n\n---\n\n');
  if (joined.length > maxChars) {
    joined = joined.slice(0, maxChars) + '\n\n[Material too long, truncated]';
  }
  return joined;
}

// Unit tests only: reset the in-memory state
function _reset() {
  docs = [];
  seq = 0;
}

module.exports = { add, update, remove, clear, summary, buildContext, _reset };
