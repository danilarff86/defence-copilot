'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Bump when a stored settings value needs a one-time migration; see migrate().
const SETTINGS_VERSION = 2;

const DEFAULTS = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  // Answer Provider: deepseek / gemini / openai / ollama
  provider: 'gemini',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: 'deepseek-chat',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: 'gpt-4o-mini',
  ollamaBaseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1/chat/completions',
  ollamaModel: 'llama3.1',
  // Transcription language: zh / en-US / multi
  sttLanguage: 'en-US',
  // Generation model (editable — put in any Flash model ID your account can use)
  genModel: 'gemini-2.5-flash',
  // Max characters of document material injected into the context
  maxContextChars: 60000,
  // Global hotkey: pressing it auto-recognizes the question and generates an answer
  hotkey: 'Control+A',
  // Auto-answer: fires automatically once the interviewer's question is detected as finished (no hotkey press needed)
  autoAnswer: false,
  // Answer character cap (a hard upper bound, not a target length; academic prose needs a larger budget)
  maxChars: 1200,
  // Answer language: auto (follows the question) / zh / en
  answerLanguage: 'auto',
  // Interview background and answering style (injected into the system prompt, highest priority)
  interviewProfile: '',
  // Target job description (persisted; uploaded or pasted, used to tailor answers)
  jobDescription: '',
  // Settings schema version, used by migrate() for one-time migrations
  schemaVersion: SETTINGS_VERSION,
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// One-time upgrades of a settings file written by an older version.
// Takes the raw parsed file (before merging DEFAULTS, so a missing
// schemaVersion still reads as v1) and returns a new object.
function migrate(saved) {
  const from = typeof saved.schemaVersion === 'number' ? saved.schemaVersion : 1;
  if (from >= SETTINGS_VERSION) return saved;
  const out = { ...saved };
  // v1 → v2: answers were outline-style and capped at 500 characters.
  // Academic prose needs a larger budget, so lift the old default. A value
  // the user chose themselves is left alone.
  if (from < 2 && out.maxChars === 500) out.maxChars = DEFAULTS.maxChars;
  out.schemaVersion = SETTINGS_VERSION;
  return out;
}

function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...migrate(JSON.parse(raw)) };
  } catch (_e) {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const merged = { ...load(), ...partial };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
  return merged;
}

module.exports = { load, save, migrate, DEFAULTS, SETTINGS_VERSION, settingsPath };
