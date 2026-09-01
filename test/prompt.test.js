'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, EXTRACTION_SYSTEM, buildExtractionUser } = require('../src/main/prompt');

const BASE = {
  question: 'q',
  transcript: '',
  context: '',
  answerLanguage: 'en',
  maxChars: 1200,
};

test('buildPrompt: asks for flowing prose and forbids lists', () => {
  const { systemInstruction } = buildPrompt(BASE);
  assert.match(systemInstruction, /FLOWING PROSE/);
  assert.match(systemInstruction, /3-8 sentences/);
  assert.match(systemInstruction, /NEVER use bullet points/);
  // The old outline instruction must be gone.
  assert.doesNotMatch(systemInstruction, /大纲式/);
  assert.doesNotMatch(systemInstruction, /要点/);
});

test('buildPrompt: maxChars is stated as a hard upper bound, not a target', () => {
  const { systemInstruction } = buildPrompt({ ...BASE, maxChars: 900 });
  assert.match(systemInstruction, /900 characters is a hard upper bound/);
});

test('buildPrompt: casts the model as a defending PhD candidate', () => {
  const { systemInstruction } = buildPrompt(BASE);
  assert.match(systemInstruction, /PhD candidate defending your own dissertation/);
  assert.match(systemInstruction, /examination committee/);
});

test('buildPrompt: carries the grounding rules from the dissertation spec', () => {
  const { systemInstruction } = buildPrompt(BASE);
  // Corpus primacy + verbatim figures.
  assert.match(systemInstruction, /primary and authoritative source/);
  assert.match(systemInstruction, /EXACTLY as they appear/);
  // General knowledge must be labelled.
  assert.match(systemInstruction, /not a result of this dissertation/);
  // No fabrication.
  assert.match(systemInstruction, /NEVER invent dissertation-specific facts/);
  // Contradictions are reported, not silently resolved.
  assert.match(systemInstruction, /contradict each other/);
  // No relevant evidence → cautious, explicitly unconfirmed.
  assert.match(systemInstruction, /not confirmed by the dissertation materials/);
  // Plain text only (the renderer does not render Markdown).
  assert.match(systemInstruction, /No Markdown/);
});

test('buildPrompt: answer-language rules stay in their target language', () => {
  assert.match(
    buildPrompt({ ...BASE, answerLanguage: 'en' }).systemInstruction,
    /Answer in English\./,
  );
  assert.match(buildPrompt({ ...BASE, answerLanguage: 'zh' }).systemInstruction, /请用中文作答。/);
  assert.match(
    buildPrompt({ ...BASE, answerLanguage: 'uk' }).systemInstruction,
    /Відповідай українською мовою\./,
  );
  assert.match(
    buildPrompt({ ...BASE, answerLanguage: 'auto' }).systemInstruction,
    /same language the question was asked in/,
  );
});

test('buildPrompt: explicit question mode includes the question and the transcript', () => {
  const { userText } = buildPrompt({
    ...BASE,
    question: 'Why this optimisation algorithm?',
    transcript: 'Committee: tell us about the method\nCandidate: certainly',
  });
  assert.match(userText, /Why this optimisation algorithm\?/);
  assert.match(userText, /RECENT SESSION TRANSCRIPT/);
  assert.match(userText, /QUESTION TO ANSWER/);
});

test('buildPrompt: extract mode (no question) answers the current question only', () => {
  const { userText } = buildPrompt({
    ...BASE,
    question: '',
    transcript: 'Committee: how did you validate the results?',
  });
  assert.match(userText, /RIGHT NOW/);
  assert.match(userText, /first sentence must already be the answer/);
  assert.doesNotMatch(userText, /QUESTION TO ANSWER/); // no explicit-question block
});

test('buildPrompt: knowledge-base context is included when provided', () => {
  const { userText } = buildPrompt({ ...BASE, context: 'Section 3.2: RMSE = 0.041' });
  assert.match(userText, /DISSERTATION MATERIALS/);
  assert.match(userText, /RMSE = 0\.041/);
});

test('buildPrompt: profile is injected as a highest-priority override', () => {
  const { systemInstruction } = buildPrompt({
    ...BASE,
    profile: 'The committee chair is a statistician.',
  });
  assert.match(systemInstruction, /HIGHEST PRIORITY/);
  assert.match(systemInstruction, /The committee chair is a statistician\./);
});

test('buildPrompt: job description is still injected as tailoring context', () => {
  const { systemInstruction } = buildPrompt({
    ...BASE,
    jobDescription: 'Defense of a thesis on adaptive control.',
  });
  assert.match(systemInstruction, /ADDITIONAL TARGET CONTEXT/);
  assert.match(systemInstruction, /adaptive control/);
});

test('extraction prompt helpers', () => {
  assert.match(EXTRACTION_SYSTEM, /ONLY that question/);
  assert.match(buildExtractionUser('Interviewer: hi'), /Interviewer: hi/);
  assert.match(buildExtractionUser('x'), /current core question is:/);
});

test('buildPrompt: answerLanguage uk produces a Ukrainian answer instruction', () => {
  const { systemInstruction } = buildPrompt({
    question: 'q',
    transcript: '',
    context: '',
    answerLanguage: 'uk',
    maxChars: 500,
  });
  assert.match(systemInstruction, /Відповідай українською мовою\./);
});
