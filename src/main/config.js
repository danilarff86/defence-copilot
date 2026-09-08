'use strict';

// Answer Provider registry.
// type: 'openai'  → goes through openaiCompat.js (OpenAI-compatible Chat Completions)
//       'gemini'  → goes through gemini.js
// keyField/modelField/baseURLField point to field names in settings.js.
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    type: 'openai',
    baseURL: 'https://api.deepseek.com/chat/completions',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    defaultModel: 'deepseek-chat',
    fallbacks: ['deepseek-v4-flash'],
  },
  openai: {
    label: 'OpenAI',
    type: 'openai',
    baseURL: 'https://api.openai.com/v1/chat/completions',
    keyField: 'openaiApiKey',
    modelField: 'openaiModel',
    defaultModel: 'gpt-4o-mini',
    fallbacks: ['gpt-4o'],
  },
  ollama: {
    label: 'Ollama (local)',
    type: 'openai',
    baseURL: 'http://localhost:11434/v1/chat/completions',
    baseURLField: 'ollamaBaseURL',
    keyField: null, // Local, no Key needed
    modelField: 'ollamaModel',
    defaultModel: 'llama3.1',
    fallbacks: [],
  },
  gemini: {
    label: 'Gemini',
    type: 'gemini',
    keyField: 'geminiApiKey',
    modelField: 'genModel',
    defaultModel: 'gemini-2.5-flash',
    fallbacks: ['gemini-2.0-flash'],
  },
};

module.exports = { PROVIDERS };
