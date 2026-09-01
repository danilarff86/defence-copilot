# Ukrainian Language Support — Design

**Date:** 2026-09-01
**Status:** Approved (brainstormed in-session)

## Goal

Let a user run an interview session in Ukrainian end-to-end: live transcription
of Ukrainian speech (STT), Ukrainian documents in the knowledge base (the
"RAG" layer), and answers generated in Ukrainian (LLM).

Target scenario (confirmed with the user): **mostly-Ukrainian speech with
English technical terms sprinkled in** — the typical Ukrainian tech interview.
Heavy whole-sentence switching between Ukrainian and English is out of scope
(Deepgram's `multi` auto-detect mode does not include Ukrainian).

## Current state

- **STT** (`src/renderer/deepgram.js`): a `DeepgramLive` class connects to
  Deepgram's streaming API. Model selection is
  `model: multi ? 'nova-3' : 'nova-2'`; the language code is passed through
  as the `language` query param. The language is chosen in two `<select>`
  elements in `src/renderer/index.html` (`langSelect` in the toolbar,
  `setSttLang` in Settings) and persisted as `settings.sttLanguage`
  (free-form string, no schema change needed).
- **LLM** (`src/main/prompt.js`): `buildPrompt()` hardcodes a `langRule`
  ternary for `zh` / `en` / anything-else (= answer in the question's
  language). The answer language is chosen in the `setAnswerLang` select in
  `index.html` and persisted as `settings.answerLanguage`. The
  question-extraction prompt already instructs "write it in the SAME language
  the interviewer is speaking" — no change needed there.
- **"RAG"** (`src/main/store.js`, `src/main/documents.js`): there is no
  retrieval step. `buildContext()` concatenates all uploaded document text
  (up to `maxContextChars`) into the prompt. `pdf-parse` / `mammoth` extract
  Unicode text. This layer is language-agnostic.

## Design

### STT

1. Add `<option value="uk">Українська</option>` to both transcript-language
   selects in `index.html` (toolbar `langSelect` and Settings `setSttLang`),
   placed after `Русский` to keep the existing ordering style.
2. In `deepgram.js`, route `uk` to **Nova-3**: Deepgram supports Ukrainian on
   both Nova-2 and Nova-3, but Nova-3 has lower word-error rate (especially
   for streaming) and tolerates code-switched English terms better.
   Implemented as a `NOVA3_LANGS` set (`['multi', 'uk']`) so future language
   upgrades are one-line additions. All other existing languages keep Nova-2
   — no behavior change for them.

### LLM

3. Add `<option value="uk">Українська</option>` to the `setAnswerLang`
   select in `index.html`.
4. In `prompt.js`, extend `langRule` with a `uk` branch:
   `'Відповідай українською мовою.'` The existing `auto` default ("answer in
   the question's language") already handles Ukrainian; the fixed `uk` choice
   is a guarantee for users who want Ukrainian answers even to English
   questions.

### RAG / knowledge base

5. **No code change.** Context-stuffing is language-agnostic. Verified by a
   new test: `chunkText` must not mangle Cyrillic (multi-byte) text.

## Testing

- `test/prompt.test.js`: new case — `answerLanguage: 'uk'` produces the
  Ukrainian instruction in `systemInstruction`.
- `test/documents.test.js`: new case — Cyrillic text chunks losslessly
  (chunks re-join to contain the original words; no replacement characters).
- Manual: launch the app, select Українська as transcript language, speak
  Ukrainian, confirm live transcript; generate an answer with answer
  language Українська.

## Out of scope

- UI localization (menus/labels stay English).
- Whole-sentence Ukrainian↔English code-switching (Deepgram `multi` lacks
  Ukrainian; revisit if Deepgram adds it).
- Adding a real retrieval/embedding pipeline.

## Files touched

| File | Change |
| --- | --- |
| `src/renderer/index.html` | `uk` option in 3 selects |
| `src/renderer/deepgram.js` | Nova-3 routing for `uk` |
| `src/main/prompt.js` | `uk` answer-language rule |
| `test/prompt.test.js` | new test case |
| `test/documents.test.js` | new test case |
