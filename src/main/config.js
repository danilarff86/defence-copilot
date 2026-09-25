'use strict';

const gemini = require('./gemini');
const openaiCompat = require('./openaiCompat');
const anthropic = require('./anthropic');

// Answer Provider registry.
// type: 'openai'    → goes through openaiCompat.js (OpenAI-compatible Chat Completions)
//       'gemini'    → goes through gemini.js
//       'anthropic' → goes through anthropic.js
// list: how models.js lists this provider's models (see models.js).
// models: curated list shown in the model picker when the live list can't be fetched.
// keyField/modelField/baseURLField point to field names in settings.js.
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    type: 'openai',
    list: 'openai-compat',
    baseURL: 'https://api.deepseek.com/chat/completions',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    defaultModel: 'deepseek-chat',
    fallbacks: ['deepseek-v4-flash'],
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'],
  },
  openai: {
    label: 'OpenAI',
    type: 'openai',
    list: 'openai',
    baseURL: 'https://api.openai.com/v1/chat/completions',
    keyField: 'openaiApiKey',
    modelField: 'openaiModel',
    defaultModel: 'gpt-4o-mini',
    fallbacks: ['gpt-4o'],
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini'],
  },
  ollama: {
    label: 'Ollama (local)',
    type: 'openai',
    list: 'openai-compat',
    baseURL: 'http://localhost:11434/v1/chat/completions',
    baseURLField: 'ollamaBaseURL',
    keyField: null, // Local, no Key needed
    modelField: 'ollamaModel',
    defaultModel: 'llama3.1',
    fallbacks: [],
    models: ['llama3.1'],
  },
  gemini: {
    label: 'Gemini',
    type: 'gemini',
    list: 'gemini',
    keyField: 'geminiApiKey',
    modelField: 'genModel',
    defaultModel: 'gemini-2.5-flash',
    fallbacks: ['gemini-2.0-flash'],
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  },
  anthropic: {
    label: 'Anthropic',
    type: 'anthropic',
    list: 'anthropic',
    keyField: 'anthropicApiKey',
    modelField: 'anthropicModel',
    defaultModel: 'claude-opus-5',
    fallbacks: ['claude-sonnet-5'],
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  },
};

const STREAMS = {
  openai: openaiCompat.generateAnswerStream,
  gemini: gemini.generateAnswerStream,
  anthropic: anthropic.generateAnswerStream,
};

function providerId(s) {
  return s.provider && PROVIDERS[s.provider] ? s.provider : 'gemini';
}

// Resolve for the current Provider: stream impl / Key / baseURL / model chain
function resolveProvider(s) {
  const id = providerId(s);
  const p = PROVIDERS[id];
  const model = ((s[p.modelField] || '') + '').trim() || p.defaultModel;
  const models = [model, ...(p.fallbacks || [])].filter((m, i, a) => a.indexOf(m) === i);
  return {
    id,
    label: p.label,
    type: p.type,
    needsKey: !!p.keyField,
    apiKey: p.keyField ? s[p.keyField] || '' : '',
    baseURL: p.baseURLField ? s[p.baseURLField] || p.baseURL : p.baseURL,
    models,
    streamFn: STREAMS[p.type],
  };
}

// The settings partial that stores `model` as the current provider's model (null for a blank model)
function modelSetting(s, model) {
  const m = ((model || '') + '').trim();
  if (!m) return null;
  return { [PROVIDERS[providerId(s)].modelField]: m };
}

module.exports = { PROVIDERS, resolveProvider, modelSetting };
