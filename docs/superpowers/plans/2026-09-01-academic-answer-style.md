# Academic Answer Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated answers read as spoken academic prose for a dissertation defense — grounded in the user's own dissertation materials, and never formatted as bullet lists.

**Architecture:** All answer shaping in this app lives in one dependency-free pure module, `src/main/prompt.js`, which `src/main/main.js` calls to build the system instruction and user text for every generation. We rewrite that module's answering doctrine (English instructions, defense persona, grounding rules ported from the sibling `dissertation/assistant` project's `answer_v1.md`), retune the question-extraction prompt for committee questions, and raise the answer-length budget that previously forced outline-form answers — including a one-time migration of the persisted setting.

**Tech Stack:** Electron (plain JS, CommonJS), `node:test` for unit tests, ESLint + Prettier.

**Spec:** `docs/superpowers/specs/2026-09-01-academic-answer-style-design.md`

## Global Constraints

- Node ≥ 18; tests run with `npm test` (`node --test`), lint with `npm run lint`, format check with `npm run format:check`.
- No new dependencies.
- `src/main/prompt.js` must stay a pure module with **no Electron imports** — that is what makes it unit-testable.
- Prompt instructions are written in **English**. The only exception is the per-language answer rule, which stays in its target language: `请用中文作答。` / `Answer in English.` / `Відповідай українською мовою.`
- The answer is rendered with `textContent` in the renderer, so the prompt must keep forbidding Markdown.
- New answer-length default is exactly `1200`; the old default being migrated from is exactly `500`.
- Settings schema version constant is `SETTINGS_VERSION = 2`; the field name is `schemaVersion`.
- Commit messages follow the repo's conventional style (`feat:`, `fix:`, `test:`, `docs:`, `style:`).
- Out of scope, do not implement: Interview/Defense mode switching, renaming the Job Description setting, evidence state / source excerpts in the UI, a "no question detected" extraction outcome.

---

### Task 1: Rewrite the answer prompt for grounded academic prose

**Files:**
- Modify: `src/main/prompt.js:5-77` (the whole `buildPrompt` function)
- Test: `test/prompt.test.js` (rewrite the six `buildPrompt` cases; leave the `extraction prompt helpers` case untouched — Task 2 owns it)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildPrompt({ question, transcript, context, answerLanguage, maxChars, profile, jobDescription }) -> { systemInstruction: string, userText: string }`. The signature is **unchanged** — `src/main/main.js:315-323` keeps calling it exactly as it does today. Task 3 relies on `maxChars` still being interpolated into `systemInstruction` as a hard ceiling.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `test/prompt.test.js` from line 1 down to (but not including) the `test('extraction prompt helpers', ...)` case with:

```js
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
```

Keep the existing `test('extraction prompt helpers', ...)` case at the end of the file exactly as it is.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/prompt.test.js`
Expected: FAIL — several `AssertionError [ERR_ASSERTION]: The input did not match the regular expression` failures, e.g. `/FLOWING PROSE/` and `/PhD candidate defending your own dissertation/`, because the current prompt is the Chinese interview prompt.

- [ ] **Step 3: Write the implementation**

Replace `src/main/prompt.js` lines 3–77 (the leading comment and the whole `buildPrompt` function) with:

```js
// Pure functions that build the answering / question-extraction prompts.
// No Electron dependency, so this module is directly unit-testable.

function buildPrompt({
  question,
  transcript,
  context,
  answerLanguage,
  maxChars,
  profile,
  jobDescription,
}) {
  // The per-language rule is deliberately written in its own target
  // language — it primes the model's output language far better than an
  // English description of it would.
  const langRule =
    answerLanguage === 'zh'
      ? '请用中文作答。'
      : answerLanguage === 'en'
        ? 'Answer in English.'
        : answerLanguage === 'uk'
          ? 'Відповідай українською мовою.'
          : 'Answer in the same language the question was asked in.';

  const lines = [
    'You are the PhD candidate defending your own dissertation before an examination committee.',
    "You will be given a committee member's question, a recent transcript of the session, and excerpts from your own dissertation materials.",
    'Answer in the first person, as if speaking aloud to the committee, in an academic but natural spoken register.',
    'Rules:',
    `1) Write FLOWING PROSE — continuous sentences that read as speech. NEVER use bullet points, dashes as list markers, numbered lists, headings or any outline structure. Aim for about 3-8 sentences; ${maxChars} characters is a hard upper bound, not a target.`,
    '2) Open with the direct answer to the question. No preamble, no "good question", no restating or summarising the question, no title such as "My answer".',
    '3) The dissertation excerpts are the primary and authoritative source of facts about this work. Reproduce numerical values, formulas, algorithm names, constraints, experimental conditions and stated conclusions EXACTLY as they appear in the excerpts — never paraphrase, round or approximate them.',
    '4) If the excerpts do not cover part of the question, you may add general knowledge from the subject area, but say explicitly that it is general background and not a result of this dissertation.',
    '5) NEVER invent dissertation-specific facts, numbers, method names, citations or references that are not present in the excerpts.',
    '6) If the excerpts contradict each other (different values for the same fact), state that discrepancy openly instead of silently picking one.',
    '7) If no excerpt is relevant to the question, give a short, careful answer from general knowledge and state plainly that it is not confirmed by the dissertation materials.',
    '8) Plain text only. No Markdown: no asterisks (**), no hash headings, no tables — the interface does not render Markdown and would show the raw characters.',
    "9) The transcript is live speech recognition and may contain repetitions, cross-talk, misrecognised words and unfinished sentences. Tolerate that noise and answer only the committee's CURRENT core question.",
    '10) Never reveal your reasoning — output only the final answer.',
    `11) ${langRule}`,
  ];
  if (jobDescription && jobDescription.trim()) {
    lines.push(
      '',
      '================ ADDITIONAL TARGET CONTEXT (tailor the answer to it: align with its requirements, terminology and keywords) ================',
      jobDescription.trim().slice(0, 6000),
    );
  }
  if (profile && profile.trim()) {
    lines.push(
      '',
      '================ SESSION BACKGROUND AND ANSWERING STYLE (HIGHEST PRIORITY — follow it) ================',
      profile.trim(),
    );
  }
  const systemInstruction = lines.join('\n');

  const parts = [];
  if (context) parts.push(`[DISSERTATION MATERIALS / KNOWLEDGE BASE EXCERPTS]\n${context}\n`);

  const q = (question || '').trim();
  if (q) {
    if (transcript) {
      parts.push(
        `[RECENT SESSION TRANSCRIPT (~15 turns, speech recognition — may contain repeats or errors; use it only for context and continuity)]\n${transcript}\n`,
      );
    }
    parts.push(`[QUESTION TO ANSWER]\n${q}`);
    parts.push('Answer it directly, using the material above.');
    parts.push('\nYour answer:');
  } else {
    parts.push(
      `[RECENT SESSION TRANSCRIPT (~15 turns, speech recognition — may contain repeats, cross-talk or errors)]\n${transcript || '(no dialogue yet)'}\n`,
    );
    parts.push(
      'Work out silently which question the committee is asking RIGHT NOW, then answer it directly. Earlier turns are background context only — do not answer an older question that was already addressed.',
    );
    parts.push(
      'Do not output any prefix or restatement — no "The core question is…", no "The committee is asking…", no "Your question is…". The first sentence must already be the answer itself.',
    );
    parts.push('\nYour answer:');
  }

  return { systemInstruction, userText: parts.join('\n') };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/prompt.test.js`
Expected: PASS — all cases in the file, including the untouched `extraction prompt helpers` case.

- [ ] **Step 5: Run the full suite and the linters**

Run: `npm test && npm run lint && npm run format:check`
Expected: all pass. If `format:check` reports `src/main/prompt.js` or `test/prompt.test.js`, run `npm run format` and re-check.

- [ ] **Step 6: Commit**

```bash
git add src/main/prompt.js test/prompt.test.js
git commit -m "feat: academic prose answers grounded in dissertation materials"
```

---

### Task 2: Retune question extraction for committee questions

**Files:**
- Modify: `src/main/prompt.js:79-81` (the `EXTRACTION_SYSTEM` constant and its comment)
- Test: `test/prompt.test.js` (replace the `extraction prompt helpers` case)

**Interfaces:**
- Consumes: `EXTRACTION_SYSTEM: string` and `buildExtractionUser(recentTranscript: string) -> string` from `src/main/prompt.js` (both already exported).
- Produces: `EXTRACTION_SYSTEM` with unchanged output contract — one clean question, no prefix, in the speaker's language — so `src/main/main.js:349-357`, which pipes the result straight into the Current Question box, needs no change. `buildExtractionUser` is not modified.

- [ ] **Step 1: Write the failing test**

In `test/prompt.test.js`, replace the existing case:

```js
test('extraction prompt helpers', () => {
  assert.match(EXTRACTION_SYSTEM, /ONLY that question/);
  assert.match(buildExtractionUser('Interviewer: hi'), /Interviewer: hi/);
  assert.match(buildExtractionUser('x'), /current core question is:/);
});
```

with:

```js
test('extraction prompt targets the committee question and keeps its contract', () => {
  // Domain: a defense, not a job interview.
  assert.match(EXTRACTION_SYSTEM, /dissertation defense/);
  assert.match(EXTRACTION_SYSTEM, /committee member/);
  assert.doesNotMatch(EXTRACTION_SYSTEM, /interview/i);
  // Spec US3 behaviours.
  assert.match(EXTRACTION_SYSTEM, /Drop introductory remarks/);
  assert.match(EXTRACTION_SYSTEM, /multi-sentence question/);
  assert.match(EXTRACTION_SYSTEM, /follow-up/);
  assert.match(EXTRACTION_SYSTEM, /terminology/);
  // Unchanged output contract.
  assert.match(EXTRACTION_SYSTEM, /ONLY that question/);
  assert.match(EXTRACTION_SYSTEM, /SAME language/);
});

test('buildExtractionUser embeds the transcript and the trailing cue', () => {
  assert.match(buildExtractionUser('Committee: hi'), /Committee: hi/);
  assert.match(buildExtractionUser('x'), /current core question is:/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/prompt.test.js`
Expected: FAIL — `/dissertation defense/` does not match, and `assert.doesNotMatch(EXTRACTION_SYSTEM, /interview/i)` fails because the current string says "noisy live interview transcripts".

- [ ] **Step 3: Write the implementation**

In `src/main/prompt.js`, replace lines 79–81:

```js
// 问题提取（只看最近几轮）
const EXTRACTION_SYSTEM =
  "You clean up noisy live interview transcripts. The transcript may contain repeats, cross-talk, ASR errors and half-sentences. Identify the interviewer's CURRENT core question and rewrite it as ONE clean, complete question. Output ONLY that question — no prefix, no quotes, no explanation. Write it in the SAME language the interviewer is speaking.";
```

with:

```js
// Question extraction (looks only at the most recent turns).
const EXTRACTION_SYSTEM =
  "You clean up noisy live transcripts of a dissertation defense. The transcript may contain repeats, cross-talk, speech-recognition errors and half-sentences. Identify the CURRENT core question a committee member is putting to the candidate and rewrite it as ONE clean, complete question. Drop introductory remarks, compliments and asides, but keep every meaningful part of a long multi-sentence question. If the latest turn is a short follow-up to an earlier question, return that follow-up rather than the earlier question. Preserve academic and technical terminology exactly as spoken. Output ONLY that question — no prefix, no quotes, no explanation. Write it in the SAME language the committee member is speaking.";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/prompt.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite and the linters**

Run: `npm test && npm run lint && npm run format:check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/prompt.js test/prompt.test.js
git commit -m "feat: extract committee questions instead of interview questions"
```

---

### Task 3: Raise the answer-length budget and migrate saved settings

**Files:**
- Modify: `src/main/settings.js` (add `SETTINGS_VERSION`, raise `maxChars`, add `migrate()`, use it in `load()`, export it)
- Modify: `src/renderer/app.js:518`, `:571`, `:592` (replace three hardcoded `500` fallbacks with one constant)
- Create: `test/settings.test.js`

**Interfaces:**
- Consumes: `buildPrompt`'s `maxChars` parameter from Task 1 — it is now a stated ceiling, so the value can safely grow.
- Produces: `migrate(saved: object) -> object` exported from `src/main/settings.js`, plus `SETTINGS_VERSION = 2` and `DEFAULTS.maxChars = 1200`. `load()` and `save()` keep their existing signatures (`load() -> object`, `save(partial: object) -> object`), so `src/main/main.js` needs no change.

- [ ] **Step 1: Write the failing test**

Create `test/settings.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { migrate, DEFAULTS, SETTINGS_VERSION } = require('../src/main/settings');

test('DEFAULTS: answer length is the academic-prose budget', () => {
  assert.strictEqual(DEFAULTS.maxChars, 1200);
  assert.strictEqual(DEFAULTS.schemaVersion, SETTINGS_VERSION);
});

test('migrate: a v1 file still on the old 500 default is lifted to the new default', () => {
  const out = migrate({ maxChars: 500, provider: 'gemini' });
  assert.strictEqual(out.maxChars, 1200);
  assert.strictEqual(out.schemaVersion, SETTINGS_VERSION);
  assert.strictEqual(out.provider, 'gemini', 'unrelated settings are preserved');
});

test('migrate: a v1 file with a user-chosen length keeps it', () => {
  assert.strictEqual(migrate({ maxChars: 800 }).maxChars, 800);
  assert.strictEqual(migrate({ maxChars: 200 }).maxChars, 200);
});

test('migrate: an already-migrated file is returned untouched', () => {
  const saved = { maxChars: 500, schemaVersion: SETTINGS_VERSION };
  assert.strictEqual(migrate(saved).maxChars, 500, 'a deliberate 500 set after migrating survives');
});

test('migrate: does not mutate its input', () => {
  const saved = { maxChars: 500 };
  migrate(saved);
  assert.strictEqual(saved.maxChars, 500);
  assert.strictEqual(saved.schemaVersion, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/settings.test.js`
Expected: FAIL — `TypeError: migrate is not a function` (the module currently exports only `load`, `save`, `DEFAULTS`, `settingsPath`).

- [ ] **Step 3: Write the implementation**

In `src/main/settings.js`, add the version constant above `DEFAULTS`:

```js
// Bump when a stored settings value needs a one-time migration; see migrate().
const SETTINGS_VERSION = 2;
```

Change the `maxChars` entry in `DEFAULTS` from:

```js
  // 答案字数上限
  maxChars: 500,
```

to:

```js
  // 答案字数上限（作为硬性上限，不是目标长度；学术散文需要更大预算）
  maxChars: 1200,
```

Add `schemaVersion` as the last entry of `DEFAULTS` (after `jobDescription`):

```js
  // 设置结构版本，供 migrate() 做一次性迁移
  schemaVersion: SETTINGS_VERSION,
```

Add `migrate()` above `load()`:

```js
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
```

Replace the body of `load()`:

```js
function load() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...migrate(JSON.parse(raw)) };
  } catch (_e) {
    return { ...DEFAULTS };
  }
}
```

Extend the exports line:

```js
module.exports = { load, save, migrate, DEFAULTS, SETTINGS_VERSION, settingsPath };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/settings.test.js`
Expected: PASS, all five cases.

- [ ] **Step 5: Align the renderer's fallback default**

In `src/renderer/app.js`, add a constant next to the other module-level constants near the top of the file (just after `'use strict';` / the first `const` block):

```js
// Keep in sync with DEFAULTS.maxChars in src/main/settings.js.
const DEFAULT_MAX_CHARS = 1200;
```

Then replace the three hardcoded fallbacks:

- line 518, in `updateCounter()`:
  ```js
  const max = state.settings ? state.settings.maxChars || DEFAULT_MAX_CHARS : DEFAULT_MAX_CHARS;
  ```
- line 571, in `openSettings()`:
  ```js
  $('setMaxChars').value = s.maxChars || DEFAULT_MAX_CHARS;
  ```
- line 592, in `saveSettings()`:
  ```js
  maxChars: parseInt($('setMaxChars').value, 10) || DEFAULT_MAX_CHARS,
  ```

No change is needed to the `<input type="number" id="setMaxChars" min="50" max="2000" />` in `src/renderer/index.html:335` — 1200 is inside that range.

No change is needed to `src/main/main.js:329-335` either: its Gemini output-token budget is `min(4096, max(160, ceil(maxChars * perChar * 1.15)))`, which at `maxChars = 1200` and `perChar = 1.1` gives 1518 tokens — well inside the 4096 ceiling — and already scales with `maxChars`.

- [ ] **Step 6: Run the full suite and the linters**

Run: `npm test && npm run lint && npm run format:check`
Expected: all pass. `npm run lint` would flag an unused `DEFAULT_MAX_CHARS`, so a pass confirms all three call sites were updated.

- [ ] **Step 7: Commit**

```bash
git add src/main/settings.js src/renderer/app.js test/settings.test.js
git commit -m "feat: raise answer length budget to 1200 chars with settings migration"
```

---

### Task 4: Update the documentation

**Files:**
- Modify: `README.md:54` (English feature bullet), `README.md:171` (Chinese summary paragraph)
- Modify: `CHANGELOG.md` (`## [Unreleased]` section)

**Interfaces:**
- Consumes: the behaviour delivered by Tasks 1–3 (prose answers, 1200-character default, committee-question extraction).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Update the English feature bullet**

In `README.md`, replace line 54:

```markdown
- ✍️ **Concise, outline-style** answers (default ≤ 500 chars), shown alongside the detected question so you can edit and regenerate.
```

with:

```markdown
- ✍️ **Spoken academic prose** — answers are continuous sentences (roughly 3–8, default ceiling 1200 chars), never bullet lists, grounded in your uploaded materials with figures, formulas and terminology reproduced verbatim; shown alongside the detected question so you can edit and regenerate.
```

- [ ] **Step 2: Update the Chinese summary**

In `README.md`, replace the trailing clause of line 171:

```
生成简洁的第一人称大纲式答案（默认 ≤500 字）。
```

with:

```
生成第一人称的学术口语化答案（连贯成段，不用要点列表；默认上限 1200 字符），数字、公式与术语严格照搬资料原文。
```

Leave the rest of line 171 unchanged.

- [ ] **Step 3: Add the changelog entry**

In `CHANGELOG.md`, inside the first `## [Unreleased]` section, add a `### Changed` entry immediately above the existing `- **Renamed the app (display name)…** ` bullet (creating no new heading — `### Changed` already exists there):

```markdown
- **Academic answer style**: answers are now flowing spoken prose (about 3–8 sentences) instead of the previous outline form with `- ` bullet points, and are cast as a dissertation-defense reply rather than a job-interview reply. The prompt now treats your Knowledge Base as the authoritative source, reproduces numbers, formulas, algorithm names and experimental conditions verbatim, labels anything drawn from general knowledge, reports contradictions between sources, and refuses to invent facts or references. Question extraction targets a committee member's current question, dropping preambles and preferring a genuine follow-up over an already-answered question.
- **Answer length default raised** from 500 to 1200 characters, since character count is now a hard ceiling rather than a target. Existing installs still on the old 500 default are migrated automatically (a length you chose yourself is kept); adjust it any time under Settings → Max characters.
```

- [ ] **Step 4: Verify the docs render and nothing else broke**

Run: `npm run format:check && npm test`
Expected: PASS. If `format:check` flags `README.md` or `CHANGELOG.md`, run `npm run format` and re-check.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe academic prose answers and the new length default"
```

---

## Manual verification (after Task 4)

Not automatable — do this before considering the work done:

1. Run `npm start`.
2. Open Settings, confirm **Max characters** shows `1200` (migrated from your saved `500`), set **Answer language** to `Українська`, and save.
3. Load one or more Ukrainian dissertation documents into the Knowledge Base.
4. Type a real defense question into the Current Question box and click **Generate Answer**.
5. Confirm the answer: is continuous prose with **no** lines beginning `- ` or `1.`, contains no `**` or `#`, opens with the answer itself rather than a preamble, and reproduces any figures from your documents exactly.
6. Ask a question your documents do not cover; confirm the answer says plainly that it is not confirmed by the dissertation materials rather than inventing a result.
