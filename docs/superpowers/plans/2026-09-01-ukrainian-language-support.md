# Ukrainian Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ukrainian as a first-class language for transcription (Deepgram), answer generation (LLM prompt), and the knowledge base, selectable in the existing UI.

**Architecture:** The app already has an end-to-end language flow: `settings.sttLanguage` feeds the `DeepgramLive` WebSocket client (`src/renderer/deepgram.js`), and `settings.answerLanguage` feeds the prompt builder (`src/main/prompt.js`). We add `uk` to that flow: a new option in three `<select>` elements, a Nova-3 model routing rule for `uk` in the Deepgram client, and a Ukrainian answer-language rule in the prompt builder. The knowledge base needs no code change (it stuffs full document text into the prompt, language-agnostically) — we add a test proving Cyrillic text survives chunking.

**Tech Stack:** Electron (plain JS, CommonJS), Deepgram streaming WebSocket API, `node:test` for unit tests, ESLint + Prettier.

**Spec:** `docs/superpowers/specs/2026-09-01-ukrainian-language-support-design.md`

## Global Constraints

- Node ≥ 18; tests run with `npm test` (`node --test`), lint with `npm run lint`.
- No new dependencies.
- `settings.sttLanguage` / `settings.answerLanguage` are free-form strings — no settings-schema change.
- Existing languages must keep their current Deepgram model (`nova-2`; `multi` keeps `nova-3`).
- UI option label for Ukrainian is exactly `Українська`; the value is exactly `uk` (Deepgram's language code).
- Commit messages follow the repo's conventional style (`feat:`, `test:`, `docs:`).

---

### Task 1: Ukrainian answer-language rule in the prompt builder

**Files:**
- Modify: `src/main/prompt.js:14-19`
- Test: `test/prompt.test.js`

**Interfaces:**
- Consumes: `buildPrompt({ question, transcript, context, answerLanguage, maxChars, profile, jobDescription })` from `src/main/prompt.js` (existing).
- Produces: `buildPrompt` now returns a `systemInstruction` containing `Відповідай українською мовою.` when `answerLanguage === 'uk'`. Task 4 relies on the `<option value="uk">` in the answer-language select mapping to this branch.

- [ ] **Step 1: Write the failing test**

Append to `test/prompt.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/prompt.test.js`
Expected: FAIL — the new test's `assert.match` throws (with `answerLanguage: 'uk'` the current code falls into the "same language as the question" default branch, so the Ukrainian string is absent).

- [ ] **Step 3: Write minimal implementation**

In `src/main/prompt.js`, replace the `langRule` ternary (lines 14–19):

```js
  const langRule =
    answerLanguage === 'zh'
      ? '请用中文作答。'
      : answerLanguage === 'en'
        ? 'Answer in English.'
        : answerLanguage === 'uk'
          ? 'Відповідай українською мовою.'
          : '使用与问题相同的语言作答。';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/prompt.test.js`
Expected: PASS (all cases, including the pre-existing `zh`/`en`/`auto` ones).

- [ ] **Step 5: Commit**

```bash
git add src/main/prompt.js test/prompt.test.js
git commit -m "feat: Ukrainian answer-language rule in prompt builder"
```

---

### Task 2: Prove the knowledge base is Cyrillic-safe

**Files:**
- Test: `test/documents.test.js`

**Interfaces:**
- Consumes: `chunkText(text, maxLen, overlap)` from `src/main/documents.js` (existing; returns `string[]`).
- Produces: nothing new — this is a characterization test locking in that chunking does not mangle multi-byte Cyrillic text. No later task depends on it.

- [ ] **Step 1: Write the test**

Append to `test/documents.test.js`:

```js
test('chunkText: Cyrillic (Ukrainian) text chunks losslessly', () => {
  const para =
    'Я працював над масштабуванням інференсу великих мовних моделей у Києві. '.repeat(20);
  const text = Array(5).fill(para.trim()).join('\n\n');
  const chunks = chunkText(text, 900, 150);
  assert.ok(chunks.length > 1);
  const joined = chunks.join(' ');
  assert.match(joined, /масштабуванням інференсу/);
  assert.doesNotMatch(joined, /�/); // no replacement characters
  for (const c of chunks) assert.ok(c.length <= 900 + 1, `chunk too long: ${c.length}`);
});
```

- [ ] **Step 2: Run the test**

Run: `node --test test/documents.test.js`
Expected: PASS — `chunkText` operates on JS strings (UTF-16 code units), so Cyrillic is inherently safe; this test exists to lock that in. **If it fails, stop: that is a real bug in `chunkText` — investigate before proceeding (do not weaken the test).**

- [ ] **Step 3: Commit**

```bash
git add test/documents.test.js
git commit -m "test: knowledge-base chunking is Cyrillic-safe"
```

---

### Task 3: Route Ukrainian to Deepgram Nova-3

**Files:**
- Modify: `src/renderer/deepgram.js:23-35`

**Interfaces:**
- Consumes: `settings.sttLanguage` value `'uk'`, passed as `opts.language` to `new DeepgramLive(opts)` by `src/renderer/app.js` (existing plumbing — no app.js change).
- Produces: a Deepgram WebSocket URL with `model=nova-3&language=uk` when `language === 'uk'`; every other non-`multi` language still gets `model=nova-2`.

Note: `deepgram.js` is a renderer-only file (it references `window` and browser `WebSocket`) and has no unit-test harness in this repo — the existing pattern is manual verification plus lint. Follow that pattern; end-to-end verification happens in Task 5.

- [ ] **Step 1: Implement the model routing**

In `src/renderer/deepgram.js`, replace lines 23–35 (`connect()` through the `language` params) with:

```js
  connect() {
    const multi = this.language === 'multi';
    // Ukrainian is best served by nova-3 (nova-2 also supports it, but with
    // higher WER); other single languages keep nova-2 to avoid behavior change.
    const NOVA3_LANGS = new Set(['multi', 'uk']);
    const params = new URLSearchParams({
      model: NOVA3_LANGS.has(this.language) ? 'nova-3' : 'nova-2',
      smart_format: 'true',
      interim_results: 'true',
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1',
      endpointing: '300',
    });
    if (multi) params.set('language', 'multi');
    else params.set('language', this.language);
```

Also update the JSDoc on line 7 from `zh / en-US / multi` to `zh / en-US / uk / multi / …`.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/deepgram.js
git commit -m "feat: route Ukrainian STT to Deepgram nova-3"
```

---

### Task 4: Ukrainian options in the UI selects

**Files:**
- Modify: `src/renderer/index.html` (three `<select>` elements: `langSelect` ~line 54, `setSttLang` ~line 306, `setAnswerLang` ~line 322)

**Interfaces:**
- Consumes: Task 1's `uk` branch in `buildPrompt` and Task 3's Nova-3 routing — the option values wire straight into existing `settings.sttLanguage` / `settings.answerLanguage` plumbing in `app.js` (no JS change).
- Produces: user-visible `Українська` choices.

- [ ] **Step 1: Add the transcript-language options**

In both the toolbar `langSelect` and the Settings `setSttLang` selects, insert after the `<option value="ru">Русский</option>` line:

```html
            <option value="uk">Українська</option>
```

(Match each select's existing indentation — the toolbar and Settings blocks differ.)

- [ ] **Step 2: Add the answer-language option**

In the `setAnswerLang` select, insert after `<option value="zh">中文</option>`:

```html
                <option value="uk">Українська</option>
```

- [ ] **Step 3: Verify formatting and full test suite**

Run: `npm run format:check && npm run lint && npm test`
Expected: all pass. If `format:check` complains about the edited lines, run `npm run format` and re-check.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat: Ukrainian option in transcript- and answer-language selects"
```

---

### Task 5: Changelog + end-to-end manual verification

**Files:**
- Modify: `CHANGELOG.md` (top `## [Unreleased]` → first `### Added` list)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: release note; verified feature.

- [ ] **Step 1: Add the changelog entry**

In `CHANGELOG.md`, add as the first bullet under the first `### Added` in `## [Unreleased]`:

```markdown
- **Ukrainian language support**: `Українська` is now selectable as the transcript language (Deepgram `nova-3`, `language=uk`) and as the answer language (answers generated in Ukrainian). Ukrainian documents in the Knowledge Base were already supported and are now covered by tests.
```

- [ ] **Step 2: Manual end-to-end check**

Run: `npm start` (or `make run`), then:
1. Toolbar → Transcript language → `Українська`; Start Listening; speak a Ukrainian sentence with an English term (e.g. «Розкажіть про ваш досвід з Kubernetes») and confirm it appears in the live transcript.
2. Settings → Answer language → `Українська`; press the answer hotkey (default `Ctrl+A`) and confirm the generated answer is in Ukrainian.
3. Upload a Ukrainian-language text/PDF into the Knowledge Base and confirm a generated answer can draw on it.

Expected: all three work. Requires a Deepgram key + one answer provider configured; if a live check isn't possible in your environment, report that explicitly instead of claiming verification.

- [ ] **Step 3: Run the full suite one last time**

Run: `npm test && npm run lint && npm run format:check`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for Ukrainian language support"
```
