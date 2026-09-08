# Electron 44 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the app to Electron 44 and declare `NSAudioCaptureUsageDescription`, so macOS captures system audio through Chromium's CoreAudio Tap path and the Interviewer channel finally works.

**Architecture:** Electron 44's Chromium uses Apple's CoreAudio Tap API by default for desktop audio capture, so no feature flags are involved — the capture code in `main.js` and `app.js` is already correct and stays as it is. What changes is the runtime version, the Info.plist declaration that CoreAudio Tap requires on macOS 14.2+, and the deletion of the inert feature-flag module from the superseded attempt. Because a missing plist key fails silently with no error from Electron, and because the two packaging paths read two different Info.plist sources by hand, a unit test enforces that both sources declare the same keys.

**Tech Stack:** Electron 44 (plain JS, CommonJS), `@electron/packager` 20 + `electron-builder` 26, macOS CoreAudio Tap via `getDisplayMedia`, `node:test` for unit tests, ESLint + Prettier.

**Spec:** `docs/superpowers/specs/2026-09-08-electron-44-upgrade-design.md`

## Global Constraints

- Node ≥ 22.12.0 for the dev toolchain; tests run with `npm test` (`node --test`), lint with `npm run lint`, format check with `npm run format:check`.
- **No new dependencies.** The Info.plist test parses XML with a regular expression rather than adding a plist library.
- Electron target version is exactly `^44.2.0`.
- The Info.plist key is exactly `NSAudioCaptureUsageDescription`, and it must be added to **both** `extend-info.plist` and `package.json` → `build.mac.extendInfo`, with identical description text.
- Do **not** add any `app.commandLine.appendSwitch` call. Electron 44 needs no feature flags for system audio; the only flag in this area (`MacCatapLoopbackAudioForScreenShare`) opts *out* of the working path.
- Do **not** change `setupDisplayMediaLoopback()` in `src/main/main.js`, the `getDisplayMedia({ video: true, audio: true })` call, or the dual-stream role assignment. They are already correct on Electron 44.
- Keep `echoCancellation: true` (`src/renderer/app.js:310`) and the audio-track guard in `getSystemStream` (`src/renderer/app.js:332-351`). The guard is the app's only failure signal, because `systemPreferences.getMediaAccessStatus()` has no media type for system audio.
- New source files under `src/main/` and `test/` are `'use strict';` CommonJS, like every existing file.
- Commit messages follow the repo's conventional style (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).

### Starting state — read this before Task 1

The working tree contains an **uncommitted, superseded** change (from
`docs/superpowers/plans/2026-09-08-macos-system-audio-loopback.md`). Nothing is
committed. Parts of it are deleted by Task 2 and parts are deliberately kept:

| Artifact | Fate |
|---|---|
| `src/main/audioLoopback.js` | **Deleted** (Task 2) — inert on 33, unnecessary on 44 |
| `test/audioLoopback.test.js` | **Deleted** (Task 2) |
| `applyLoopbackFeatureFlags()` + import, `src/main/main.js:24-38` | **Reverted** (Task 2) |
| `echoCancellation: true`, `src/renderer/app.js:310` | **Kept** |
| Audio-track guard in `getSystemStream`, `src/renderer/app.js:332-351` | **Kept** |
| README macOS row + CHANGELOG bullet describing feature flags | **Rewritten** (Task 4) — they describe a fix that does not work |

---

### Task 0: Translate all source comments to English

**Files:**
- Modify: every file under `src/` and `test/` that contains a Chinese comment — currently `src/main/main.js`, `src/main/settings.js`, `src/main/store.js`, `src/main/documents.js`, `src/main/config.js`, `src/main/llm.js`, `src/main/gemini.js`, `src/main/openaiCompat.js`, `src/main/preload.js`, `src/main/prompt.js`, `src/main/_gifDemo.js`, `src/main/_screenshotDemo.js`, `src/main/audioLoopback.js`, `src/renderer/app.js`, `src/renderer/deepgram.js`, `src/renderer/pcm-worklet.js`, `src/renderer/index.html`, `test/llm.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a codebase whose comments are entirely English. Every later task writes English comments, and Task 2 locates code by identifier rather than by comment text because this task rewrites those comments.

This task runs first so that no later task writes a comment that immediately
needs translating, and so the diff for the Electron work is not tangled with a
repo-wide comment rewrite.

**Scope — comments ONLY.** Three kinds of Chinese text exist in this repo and
only the first may be touched:

| Kind | Example | Action |
|---|---|---|
| Comments — `//`, `/* */`, JSDoc, inline trailing, `<!-- -->` | `// 懒加载： { id, name, text, chars }[]` | **Translate** |
| User-facing runtime strings | `throw new Error('缺少 Gemini API Key')`, `title: '选择岗位 JD 文件'` | **Leave unchanged** |
| Functionally load-bearing Chinese | see the do-not-touch list below | **Leave unchanged** |

**Do-not-touch list — changing any of these breaks behaviour or tests:**

- `src/main/prompt.js:20` — `'请用中文作答。'`. This is the Chinese answer-language rule; it is written in the target language deliberately to prime the model's output language, and `test/prompt.test.js:58` asserts it verbatim.
- `src/renderer/index.html` — the `中文` and `日本語` `<option>` labels (lines 56, 58, 309, 311, 327). These are UI labels naming languages in their own script.
- `src/main/store.js:100` — `` `### 资料：${d.name}\n${d.text}` `` and `src/main/store.js:103` — `'\n\n[资料过长，已截断]'`. Both are injected into the LLM prompt, and `test/store.test.js:46` asserts `/已截断/`.
- `test/prompt.test.js:21,22,58` and `test/store.test.js:46` — the assertion regexes `/大纲式/`, `/要点/`, `/请用中文作答。/`, `/已截断/`. These match product strings, not comments.
- Every other string literal and template literal in the repo, including `console.error` messages, `dialog.showOpenDialog` titles, and file-filter names.

- [ ] **Step 1: Record the current test baseline**

Run: `npm test`
Expected: PASS. Write down the exact totals line (`# tests N`, `# pass N`, `# fail 0`) — Step 4 must reproduce it exactly, since translating comments cannot change behaviour.

- [ ] **Step 2: Translate the comments**

Work file by file through the list above. For each file, find every comment with
`grep -nP '[\x{4e00}-\x{9fff}]' <file>`, decide whether each hit is a comment or
one of the protected categories, and rewrite only the comments in English.

Preserve the author's intent and level of detail rather than shortening — these
comments explain non-obvious decisions. For example, in `src/main/store.js`:

```js
// Knowledge base: stores the plain text of uploaded/pasted documents and
// splices all of it into the context when answering.
// Persisted to userData/knowledge.json — add/remove/update/clear all write to
// disk, so it survives a restart.
// No vector retrieval: Flash and other large-context models have plenty of
// room, so the interview material is fed in directly.
```

and in `src/renderer/pcm-worklet.js`:

```js
const ch = input[0]; // Float32Array, typically 128 samples
```

Keep each comment on the same line as the code it annotates when it was a
trailing comment, and keep block comments as block comments.

- [ ] **Step 3: Verify no Chinese comment remains, and no protected string was touched**

Run:

```bash
grep -rnP '[\x{4e00}-\x{9fff}]' src/ test/ | grep -P '(^|\s)(//|/\*|\*|<!--)'
```

Expected: **no output** — every remaining Chinese hit must be a string literal, not a comment.

Then confirm the protected strings survived:

```bash
grep -c '请用中文作答' src/main/prompt.js && grep -c '已截断' src/main/store.js && grep -c '中文' src/renderer/index.html
```

Expected: `1`, `1`, and `3` respectively.

- [ ] **Step 4: Verify behaviour is unchanged**

Run: `npm test && npm run lint && npm run format:check`
Expected: PASS, with the totals line **identical** to the baseline from Step 1. A changed test count means something other than a comment was edited.

- [ ] **Step 5: Commit**

This commit also carries the kept renderer changes from the superseded attempt
(`echoCancellation: true` and the `getSystemStream` audio-track guard), which are
currently uncommitted and are part of the fix.

```bash
git add -A src test
git commit -m "refactor: translate source comments to English"
```

---

### Task 1: Enforce and add the system-audio Info.plist key

**Files:**
- Create: `test/packaging.test.js`
- Modify: `extend-info.plist`
- Modify: `package.json` (the `build.mac.extendInfo` object)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the invariant that `extend-info.plist` and `package.json` → `build.mac.extendInfo` declare an identical set of `NS*UsageDescription` keys including `NSAudioCaptureUsageDescription`. Task 5's manual verification depends on this key being present in the packaged app.

This task comes first because it is the only part of the change with a testable
property, and because it is independent of the Electron version — the key is
required regardless of when the runtime bump lands.

- [ ] **Step 1: Write the failing test**

Create `test/packaging.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// extend-info.plist feeds @electron/packager (`make app`); build.mac.extendInfo
// feeds electron-builder (`npm run dist:mac`). They are maintained by hand and
// must not drift: a key present in only one produces an app that captures audio
// when built one way and silently fails when built the other.
function plistUsageKeys() {
  const xml = fs.readFileSync(path.join(ROOT, 'extend-info.plist'), 'utf8');
  return [...xml.matchAll(/<key>(NS\w*UsageDescription)<\/key>/g)].map((m) => m[1]).sort();
}

function builderUsageKeys() {
  const extendInfo = require(path.join(ROOT, 'package.json')).build.mac.extendInfo;
  return Object.keys(extendInfo)
    .filter((k) => /^NS\w*UsageDescription$/.test(k))
    .sort();
}

test('extend-info.plist declares the system-audio usage description', () => {
  assert.ok(
    plistUsageKeys().includes('NSAudioCaptureUsageDescription'),
    'CoreAudio Tap capture fails silently on macOS 14.2+ without this key',
  );
});

test('electron-builder config declares the system-audio usage description', () => {
  assert.ok(
    builderUsageKeys().includes('NSAudioCaptureUsageDescription'),
    'CoreAudio Tap capture fails silently on macOS 14.2+ without this key',
  );
});

test('both packaging paths declare the same usage-description keys', () => {
  assert.deepStrictEqual(plistUsageKeys(), builderUsageKeys());
});

test('every usage description is a non-empty string', () => {
  const extendInfo = require(path.join(ROOT, 'package.json')).build.mac.extendInfo;
  for (const [key, value] of Object.entries(extendInfo)) {
    if (!/^NS\w*UsageDescription$/.test(key)) continue;
    assert.strictEqual(typeof value, 'string', `${key} must be a string`);
    assert.ok(value.trim().length > 0, `${key} must not be empty — macOS shows it in the prompt`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/packaging.test.js`
Expected: FAIL with **exactly 2 of the 4 tests failing** — the two `NSAudioCaptureUsageDescription` assertions, because neither source declares the key yet. The `deepStrictEqual` sync test passes at this point (both sources hold the same two keys) and so does the non-empty-string test. If you instead see 3 failures, the two sources have already drifted; read both files and reconcile them before continuing.

- [ ] **Step 3: Add the key to `extend-info.plist`**

In `extend-info.plist`, insert this pair immediately after the closing
`</string>` of `NSMicrophoneUsageDescription` and before the
`<key>NSScreenCaptureUsageDescription</key>` line:

```xml
  <key>NSAudioCaptureUsageDescription</key>
  <string>Real Time Interview Copilot captures your computer's audio (the interviewer) so it can be transcribed.</string>
```

- [ ] **Step 4: Add the same key to the electron-builder config**

In `package.json`, inside `build.mac.extendInfo`, add the key with **identical**
text so the sync test passes:

```json
      "NSAudioCaptureUsageDescription": "Real Time Interview Copilot captures your computer's audio (the interviewer) so it can be transcribed.",
```

Place it before the existing `"NSMicrophoneUsageDescription"` entry so the object
reads alphabetically.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/packaging.test.js`
Expected: PASS — 4 tests, 0 failures.

- [ ] **Step 6: Run the full suite and lint**

Run: `npm test && npm run lint && npm run format:check`
Expected: PASS. Note the total test count — it still includes the 10 `audioLoopback` tests that Task 2 removes.

- [ ] **Step 7: Commit**

```bash
git add test/packaging.test.js extend-info.plist package.json
git commit -m "feat: declare NSAudioCaptureUsageDescription on both packaging paths"
```

---

### Task 2: Delete the inert feature-flag module

**Files:**
- Delete: `src/main/audioLoopback.js`
- Delete: `test/audioLoopback.test.js`
- Modify: `src/main/main.js:24-38` (remove the import, the function, and its call)

**Interfaces:**
- Consumes: nothing.
- Produces: a `src/main/main.js` with no `app.commandLine` usage at all. Task 3's Electron bump relies on there being no feature flags to re-validate.

- [ ] **Step 1: Delete the module and its test**

```bash
rm src/main/audioLoopback.js test/audioLoopback.test.js
```

- [ ] **Step 2: Remove the wiring from `main.js`**

**Locate this code by identifier, not by comment text.** Task 0 rewrote the
comments in this block into English, so the Chinese shown below no longer matches
the file. Find the block by searching for `applyLoopbackFeatureFlags` and
`require('./audioLoopback')`, and delete the import, its explanatory comment
(whatever language it is now in), the function, and the bare call — the whole
run of lines from the `require('./audioLoopback')` line through
`applyLoopbackFeatureFlags();` inclusive:

```js
const { FEATURE_SWITCH, buildLoopbackFeatures } = require('./audioLoopback');

// macOS/Linux 上系统声音采集需要 Chromium feature flag，且必须在 app ready 之前设置，
// 所以这里在模块顶层立即执行，不能挪进 whenReady()。
function applyLoopbackFeatureFlags() {
  const merged = buildLoopbackFeatures({
    platform: process.platform,
    existing: app.commandLine.getSwitchValue(FEATURE_SWITCH),
  });
  if (!merged) return;
  if (app.commandLine.hasSwitch(FEATURE_SWITCH)) app.commandLine.removeSwitch(FEATURE_SWITCH);
  app.commandLine.appendSwitch(FEATURE_SWITCH, merged);
}

applyLoopbackFeatureFlags();
```

Leave the `const { PROVIDERS } = require('./config');` line above it and the
`// 按当前 Provider（config.js 注册表）解析出：...` comment below it untouched.

- [ ] **Step 3: Verify no trace of the module remains**

Run: `grep -rn "audioLoopback\|applyLoopbackFeatureFlags\|FEATURE_SWITCH\|commandLine" src/ test/`
Expected: **no output at all.** Any hit means the removal is incomplete.

- [ ] **Step 4: Verify `main.js` still parses**

Run: `node --check src/main/main.js`
Expected: no output, exit 0.

- [ ] **Step 5: Run tests and lint**

Run: `npm test && npm run lint && npm run format:check`
Expected: PASS, with the total 10 lower than in Task 1 Step 6 — the `audioLoopback` suite is gone.

- [ ] **Step 6: Commit**

```bash
git add -A src/main test
git commit -m "fix: drop the inert loopback feature-flag module"
```

---

### Task 3: Bump Electron to 44 and clear the stale runtime cache

**Files:**
- Modify: `package.json` (`devDependencies.electron`, `engines.node`)
- Modify: `.nvmrc`
- Delete: `.electron-cache/` (gitignored download cache)

**Interfaces:**
- Consumes: the flag-free `src/main/main.js` from Task 2.
- Produces: an installed Electron 44 runtime whose Chromium uses CoreAudio Tap by default. Task 5's manual verification depends on it.

- [ ] **Step 1: Clear the stale Electron zip cache**

The Makefile passes the first subdirectory of `.electron-cache/` to the packager
as `--electron-zip-dir`, and that directory currently holds only
`electron-v33.4.11-darwin-arm64.zip`. Leaving it there points the packager at the
old runtime — the exact way to "upgrade" and observe no change.

```bash
rm -rf .electron-cache dist
```

- [ ] **Step 2: Raise the Node floor to what the toolchain already requires**

`@electron/packager@^20` declares `"node": ">= 22.12.0"`, so the current `.nvmrc`
of `20` cannot package the app at all. In `package.json`, change:

```json
  "engines": {
    "node": ">=22.12.0"
  },
```

And write `.nvmrc` as a single line:

```
22
```

- [ ] **Step 3: Bump the Electron dependency**

In `package.json`, under `devDependencies`, change the `electron` entry to:

```json
    "electron": "^44.2.0",
```

- [ ] **Step 4: Install**

Run: `npm install`
Expected: completes without an `EBADENGINE` error, and downloads the Electron 44 binary (this takes a while — it is a fresh ~100 MB download because Step 1 cleared the cache).

- [ ] **Step 5: Verify the installed runtime is actually 44**

Run: `node -e "console.log(require('./node_modules/electron/package.json').version)"`
Expected: a `44.x.y` version string. Anything starting with `33.` means the install did not take — re-check Step 3 and re-run `npm install`.

- [ ] **Step 6: Verify the new Chromium has the system-audio capability**

Run:

```bash
strings -a node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron\ Framework.framework/Versions/Current/Electron\ Framework | grep -c "MacCatapSystemAudioLoopbackCapture"
```

Expected: a count of **1 or more**. This is the check that proves the upgrade delivered what Electron 33 lacked — the same search returned zero on 33. A count of `0` means this Electron still cannot capture system audio and you must STOP and report it rather than proceeding to build.

- [ ] **Step 7: Run tests and lint**

Run: `npm test && npm run lint && npm run format:check`
Expected: PASS. The unit suites are pure modules and are unaffected by the runtime version.

- [ ] **Step 8: Verify the app boots on the new runtime**

Run: `node --check src/main/main.js`
Expected: no output, exit 0.

Do **not** run `npm start` here — it opens a GUI window that will not close on its own in an automated session, and a terminal-launched dev build cannot hold the Screen Recording grant anyway. The real launch is Task 5.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json .nvmrc
git commit -m "chore: upgrade Electron 33 -> 44 for macOS CoreAudio Tap audio capture"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md:59` (Requirements line)
- Modify: `README.md:110` (macOS row of the Platform support table)
- Modify: `CHANGELOG.md` (replace the superseded `### Fixed` bullet)

**Interfaces:**
- Consumes: the behaviour delivered by Tasks 1–3.
- Produces: nothing code-facing.

- [ ] **Step 1: State the two different macOS floors in Requirements**

In `README.md`, replace line 59:

```markdown
- **macOS 13+**, **Windows**, or **Linux** — runs on all three; system-audio capture is most seamless on macOS (see [Platform support](#platform-support)).
```

with:

```markdown
- **macOS 13+**, **Windows**, or **Linux** — runs on all three. Capturing the interviewer's audio needs **macOS 14.2+**; on macOS 13–14.1 use the [virtual-device fallback](#platform-support).
```

- [ ] **Step 2: Rewrite the macOS row of the Platform support table**

In `README.md`, replace line 110 — which currently describes the ScreenCaptureKit
loopback path that this change replaces:

```markdown
| macOS 13+ | `make run` (builds & opens the app) or a `.dmg` | ✅ | ✅ ScreenCaptureKit loopback (reliable on 13.2+) — grant Screen Recording, shown as "Screen & System Audio Recording" on recent macOS. The screen-recording indicator appears even though only audio is captured. |
```

with:

```markdown
| macOS 13+ | `make run` (builds & opens the app) or a `.dmg` | ✅ | ✅ on **macOS 14.2+** via CoreAudio Tap — grant **Screen & System Audio Recording**, and allow system-audio recording when macOS asks. macOS shows a screen-recording indicator even though only audio is captured. On macOS 13–14.1 use the virtual-device fallback below. |
```

- [ ] **Step 3: Replace the superseded changelog bullet**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, replace the bullet that
begins `- **System audio is now actually captured on macOS.** The loopback path
needs two Chromium feature flags` — it credits a fix that provably does not work
— with:

```markdown
- **System audio is now actually captured on macOS.** The Chromium shipped in Electron 33 had no macOS system-audio capture at all, so `getDisplayMedia` handed back a stream with no usable audio: on headphones the interviewer was never transcribed, and on speakers their speech reached only the microphone and was labelled **You**. The app now runs on Electron 44, whose Chromium captures system audio through Apple's CoreAudio Tap API (macOS 14.2+), and declares the `NSAudioCaptureUsageDescription` permission that API requires. The microphone also runs with echo cancellation so speaker output no longer bleeds into the candidate channel, and a system stream that arrives without an audio track now raises a visible error instead of silently degrading to mic-only.
```

- [ ] **Step 4: Verify formatting**

Run: `npm run format:check`
Expected: PASS. If it fails, run `npm run format` and re-check.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe the Electron 44 system-audio upgrade"
```

---

### Task 5: Manual verification on the packaged app

**Files:** none — verification only.

**Interfaces:**
- Consumes: the complete change from Tasks 1–4.
- Produces: a go/no-go. Nothing downstream depends on it.

This is the only step that can close the bug. It needs a human at the machine: a
real TCC grant, a real meeting, and a GUI.

- [ ] **Step 1: Build and open the signed app**

Run: `make app`
Expected: packages into `dist/Real Time Interview Copilot-darwin-<arch>/` and opens the app.

- [ ] **Step 2: Replace the installed copy**

macOS attaches permission grants to a specific path, and
`/Applications/Real Time Interview Copilot.app` is what actually launches on this
machine. Quit the running app, then replace that copy with the freshly built one
from `dist/` and launch it from `/Applications`. Verifying the `dist/` copy while
the stale `/Applications` copy is the one being granted permissions is how the
previous round produced a confusing result.

- [ ] **Step 3: Grant both permissions**

In System Settings → Privacy & Security:
- **Screen & System Audio Recording** — remove any stale
  `Real Time Interview Copilot` entry and add the new build. The ad-hoc signature
  changes on every build, so macOS treats each build as a new binary and prior
  grants do not carry over.
- When macOS prompts to allow recording system audio, allow it. This prompt is
  new — it is the `NSAudioCaptureUsageDescription` key from Task 1 taking effect,
  and its absence is what made the failure silent before.

Restart the app after granting.

- [ ] **Step 4: Verify with headphones**

Start a Teams call with audio in headphones, click **Start Listening**, and have
the other party speak.
Expected: their speech appears under **Interviewer**, and nothing appears under
**You** while they talk. Before this change there was no `Interviewer` transcript
at all in this setup.

- [ ] **Step 5: Verify with the built-in speakers**

Switch output to the MacBook speakers and repeat.
Expected: their speech still appears under **Interviewer**, and does **not** also
appear as a duplicate **You** line — that half is echo cancellation's job.

- [ ] **Step 6: Verify the failure is visible**

Revoke the Screen & System Audio Recording permission, restart the app, and click
**Start Listening**.
Expected: a toast appears — either the "needs Screen Recording permission" one or
"Couldn't capture system audio: … — continuing with mic only" — rather than a
session that looks healthy while mislabelling everything.

- [ ] **Step 7: Re-grant and report**

Re-enable the permission so the app is left working. No commit.

Report which of Steps 4–6 passed. If Step 4 fails — still no `Interviewer`
transcript on headphones — do **not** start adding feature flags. Report the
result with the output of Task 3 Step 6 and confirmation that the app launched
from `/Applications` is the new build (check its Info.plist contains
`NSAudioCaptureUsageDescription`).
