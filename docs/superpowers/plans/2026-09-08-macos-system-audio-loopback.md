# macOS System-Audio Loopback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Interviewer channel actually capture system audio on macOS, so the other party's speech stops being transcribed under the `You` label.

**Architecture:** The existing `setDisplayMediaRequestHandler` in `src/main/main.js` already answers with `audio: 'loopback'` — the correct shape. What is missing is the pair of Chromium feature flags that unlock loopback capture on macOS, which must be appended to the command line before app ready. We add a dependency-free pure module that builds the `enable-features` value per platform (unit-testable without booting Electron), call it at module scope in `main.js`, enable echo cancellation on the microphone so speaker output stops leaking into the candidate channel, and make the renderer throw when the system stream comes back without an audio track instead of silently succeeding.

**Tech Stack:** Electron 33 (plain JS, CommonJS), Chromium `enable-features` command-line switch, WebRTC `getDisplayMedia` / `getUserMedia`, `node:test` for unit tests, ESLint + Prettier.

**Spec:** `docs/superpowers/specs/2026-09-08-macos-system-audio-loopback-design.md`

## Global Constraints

- Node ≥ 18; tests run with `npm test` (`node --test`), lint with `npm run lint`, format check with `npm run format:check`.
- **No new dependencies.** The flag names are copied from `alectrocute/electron-audio-loopback`; the library itself is not installed.
- Electron stays pinned at `^33.2.0`. Do not bump it.
- The feature-flag switch key is exactly `enable-features`.
- macOS flag names are exactly `MacLoopbackAudioForScreenShare` and `MacSckSystemAudioLoopbackOverride`. The Linux flag name is exactly `PulseaudioLoopbackForScreenShare`. Windows gets no flags.
- Flags must be applied **before** `app.whenReady()` — Chromium reads command-line switches at startup and ignores later changes.
- `getDisplayMedia` must keep requesting `video: true`; loopback fails outright without it, even though the video track is discarded.
- New source files under `src/main/` are `'use strict';` CommonJS modules, like every existing file there.
- Commit messages follow the repo's conventional style (`feat:`, `fix:`, `test:`, `docs:`).

---

### Task 1: Pure module that builds the platform feature-flag value

**Files:**
- Create: `src/main/audioLoopback.js`
- Create: `test/audioLoopback.test.js`

**Interfaces:**
- Consumes: nothing. This module has no imports — it must stay loadable under plain `node --test` without Electron.
- Produces: `FEATURE_SWITCH` (the string `'enable-features'`) and `buildLoopbackFeatures({ platform, existing })`, which returns a comma-joined feature string, or `null` when the platform needs no flags. Task 2 imports both by these exact names.

- [ ] **Step 1: Write the failing test**

Create `test/audioLoopback.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FEATURE_SWITCH, buildLoopbackFeatures } = require('../src/main/audioLoopback');

test('FEATURE_SWITCH is the Chromium enable-features switch', () => {
  assert.strictEqual(FEATURE_SWITCH, 'enable-features');
});

test('darwin gets both macOS loopback flags', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'darwin' }),
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
});

test('linux gets the PulseAudio loopback flag', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'linux' }),
    'PulseaudioLoopbackForScreenShare',
  );
});

test('win32 needs no flags (loopback is native there)', () => {
  assert.strictEqual(buildLoopbackFeatures({ platform: 'win32' }), null);
});

test('an unknown platform needs no flags', () => {
  assert.strictEqual(buildLoopbackFeatures({ platform: 'freebsd' }), null);
});

test('an existing enable-features value is preserved, required flags appended', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'darwin', existing: 'SomeOtherFeature' }),
    'SomeOtherFeature,MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
});

test('a flag that is already present is not duplicated', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'darwin', existing: 'MacLoopbackAudioForScreenShare' }),
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
});

test('empty, whitespace and absent existing values produce no stray separators', () => {
  const expected = 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride';
  assert.strictEqual(buildLoopbackFeatures({ platform: 'darwin', existing: '' }), expected);
  assert.strictEqual(buildLoopbackFeatures({ platform: 'darwin', existing: '  ,  ' }), expected);
  assert.strictEqual(buildLoopbackFeatures({ platform: 'darwin', existing: undefined }), expected);
});

test('surrounding whitespace in an existing value is trimmed', () => {
  assert.strictEqual(
    buildLoopbackFeatures({ platform: 'darwin', existing: ' A , B ' }),
    'A,B,MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride',
  );
});

test('called with no arguments it returns null instead of throwing', () => {
  assert.strictEqual(buildLoopbackFeatures(), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/audioLoopback.test.js`
Expected: FAIL — `Cannot find module '../src/main/audioLoopback'`, because the module does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/audioLoopback.js`:

```js
'use strict';

// 系统声音（面试官）走 getDisplayMedia 的 loopback 采集。
// Electron 31.0.1–38.x 在 macOS/Linux 上需要显式打开 Chromium 的 feature flag，
// 且必须在 app ready 之前写进命令行；Electron 39+ 已内置，无需这些开关。
// Flag 名称取自 alectrocute/electron-audio-loopback (src/config.ts)。
const FEATURE_SWITCH = 'enable-features';

const LOOPBACK_FEATURES = {
  // MacSckSystemAudioLoopbackOverride 让 loopback 走 ScreenCaptureKit（macOS 13.2+）。
  darwin: ['MacLoopbackAudioForScreenShare', 'MacSckSystemAudioLoopbackOverride'],
  linux: ['PulseaudioLoopbackForScreenShare'],
  // win32 原生支持 loopback，不需要开关。
};

// 合并而不是覆盖：保留命令行上已有的 enable-features 值，只补上缺失的开关。
function buildLoopbackFeatures({ platform, existing } = {}) {
  const required = LOOPBACK_FEATURES[platform];
  if (!required || !required.length) return null;

  const merged = (existing || '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  for (const f of required) {
    if (!merged.includes(f)) merged.push(f);
  }
  return merged.join(',');
}

module.exports = { FEATURE_SWITCH, LOOPBACK_FEATURES, buildLoopbackFeatures };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/audioLoopback.test.js`
Expected: PASS — 10 tests, 0 failures.

- [ ] **Step 5: Run the full suite and lint**

Run: `npm test && npm run lint`
Expected: PASS — the new module is standalone, so nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add src/main/audioLoopback.js test/audioLoopback.test.js
git commit -m "feat: add platform loopback feature-flag builder"
```

---

### Task 2: Apply the flags in the main process before app ready

**Files:**
- Modify: `src/main/main.js:16-23` (the `require` block — append one import beneath it, plus the new function and its call)

**Interfaces:**
- Consumes: `FEATURE_SWITCH` and `buildLoopbackFeatures({ platform, existing })` from `src/main/audioLoopback.js` (Task 1).
- Produces: nothing importable. The observable effect is that `getDisplayMedia` with `audio: 'loopback'` yields a real audio track on macOS, which Task 3's audio-track guard depends on.

This task has no unit test: `main.js` calls `require('electron')` at load time and cannot be loaded by `node --test`. The logic it depends on is already covered by Task 1; this step is pure wiring, verified by lint and by the manual run in Task 5.

- [ ] **Step 1: Add the import**

In `src/main/main.js`, immediately after the existing line
`const { PROVIDERS } = require('./config');` (line 23), add:

```js
const { FEATURE_SWITCH, buildLoopbackFeatures } = require('./audioLoopback');
```

- [ ] **Step 2: Add the flag-application function and call it at module scope**

Directly beneath the import added in Step 1 — and above the existing
`// 按当前 Provider（config.js 注册表）解析出：...` comment — insert:

```js
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

- [ ] **Step 3: Verify the call sits before app ready**

Run: `grep -n "applyLoopbackFeatureFlags();\|app.whenReady()" src/main/main.js`
Expected: two lines, with the `applyLoopbackFeatureFlags();` line number **smaller** than the `app.whenReady()` line number. If it is not, move the call up — flags set after ready are ignored by Chromium and the fix silently does nothing.

- [ ] **Step 4: Run tests and lint**

Run: `npm test && npm run lint`
Expected: PASS — no test touches `main.js`; lint must report no unused-variable or undefined-variable errors for the new import.

- [ ] **Step 5: Confirm the app still boots**

Run: `npm start`
Expected: the window opens with no error in the terminal. Close it. (System audio is not verified here — the dev build launched from a terminal cannot hold the Screen Recording grant; that is Task 5's job with a packaged app.)

- [ ] **Step 6: Commit**

```bash
git add src/main/main.js
git commit -m "fix: enable Chromium loopback feature flags for macOS system audio"
```

---

### Task 3: Echo cancellation on the mic, and fail loudly on a silent system stream

**Files:**
- Modify: `src/renderer/app.js:305-313` (`getMicStream`)
- Modify: `src/renderer/app.js:332-341` (`getSystemStream`)

**Interfaces:**
- Consumes: nothing from earlier tasks at the code level; it relies on Task 2 having made a real audio track available, otherwise the new guard will (correctly) throw on every macOS run.
- Produces: `getSystemStream(value)` now rejects with an `Error` when the loopback stream carries no audio track. The existing `catch` in `startListening` (`app.js:395-398`) and `handleSystemCaptureError` (`app.js:314-330`) already handle a thrown error — no new call site is added.

This task has no unit test: the repo has no DOM or renderer test harness (`test/` covers `src/main/` only), and adding one is out of scope per the spec. Verified manually in Task 5.

- [ ] **Step 1: Enable echo cancellation on the microphone**

In `src/renderer/app.js`, in `getMicStream`, change the constraint at line 310
from `echoCancellation: false` to:

```js
      // 开启回声消除：否则外放时麦克风会听到对方的声音，并被标成 You。
      echoCancellation: true,
```

Leave `noiseSuppression: true` and the `deviceId` spread exactly as they are.

- [ ] **Step 2: Drop the video track properly and reject a stream with no audio**

In `src/renderer/app.js`, replace the whole `getSystemStream` function
(lines 332–341) with:

```js
async function getSystemStream(value) {
  if (value === '__loopback__') {
    // 通过主进程的 displayMediaRequestHandler 抓取系统声音。
    // 必须请求 video:true，否则 loopback 直接失败——拿到之后立刻丢弃视频轨。
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    // 没拿到音频轨说明 loopback 没生效（缺 feature flag / 缺屏幕录制权限）。
    // 这里必须抛错，否则会静默地只跑麦克风，把面试官的话标成 You。
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('system audio returned no audio track');
    }
    return stream;
  }
  return navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: value } } });
}
```

- [ ] **Step 3: Run tests, lint and format check**

Run: `npm test && npm run lint && npm run format:check`
Expected: PASS on all three. If `format:check` complains, run `npm run format` and re-check.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app.js
git commit -m "fix: cancel mic echo and reject a system stream with no audio"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md:110` (the macOS row of the Platform support table)
- Modify: `CHANGELOG.md` (the `## [Unreleased]` / `### Fixed` section)

**Interfaces:**
- Consumes: the behaviour delivered by Tasks 1–3.
- Produces: nothing code-facing.

- [ ] **Step 1: Note the permission's current macOS name in the README table**

In `README.md`, replace line 110:

```markdown
| macOS 13+ | `make run` (builds & opens the app) or a `.dmg` | ✅ | ✅ Screen-Capture loopback — grant Screen Recording |
```

with:

```markdown
| macOS 13+ | `make run` (builds & opens the app) or a `.dmg` | ✅ | ✅ ScreenCaptureKit loopback (reliable on 13.2+) — grant Screen Recording, shown as "Screen & System Audio Recording" on recent macOS. The screen-recording indicator appears even though only audio is captured. |
```

The platform column stays `macOS 13+` so the table keeps agreeing with
`README.md:59` and the Requirements section; the 13.2 floor is a loopback
reliability detail and belongs in the note.

- [ ] **Step 2: Add the changelog entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, add as the first bullet:

```markdown
- **System audio is now actually captured on macOS.** The loopback path needs two Chromium feature flags (`MacLoopbackAudioForScreenShare`, `MacSckSystemAudioLoopbackOverride`) that were never set, so `getDisplayMedia` returned a video-only stream: on headphones the interviewer was never transcribed at all, and on speakers their speech leaked into the microphone and was labelled **You**. The flags are now applied before app startup, the microphone runs with echo cancellation so speaker output no longer bleeds into the candidate channel, and a system stream that arrives without an audio track now raises a visible error instead of silently degrading to mic-only.
```

- [ ] **Step 3: Verify the docs are formatted**

Run: `npm run format:check`
Expected: PASS. If it fails, run `npm run format` and re-check.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: describe the macOS system-audio loopback fix"
```

---

### Task 5: Manual verification on the packaged app

**Files:** none — verification only.

**Interfaces:**
- Consumes: the complete change from Tasks 1–4.
- Produces: a go/no-go on the fix. Nothing downstream depends on it.

This is the only step that can prove the fix, because the flags, the TCC permission and the ScreenCaptureKit path all exist outside the reach of `node --test`.

- [ ] **Step 1: Build and open the signed app**

Run: `make app`
Expected: builds into `dist/` and opens `Real Time Interview Copilot.app`.

- [ ] **Step 2: Re-grant Screen Recording**

Open System Settings → Privacy & Security → Screen & System Audio Recording, and
enable **Real Time Interview Copilot**. The app is ad-hoc signed, so every
rebuild changes its signature and macOS treats it as a new binary — an existing
grant from a previous build does not carry over. Remove any stale entry, add the
fresh one, and restart the app when prompted.

- [ ] **Step 3: Verify with headphones**

Start a Teams call with audio routed to headphones, click **Start Listening**,
and have the other party speak.
Expected: their speech appears under **Interviewer**. Nothing appears under
**You** while they are talking. (Before this change there was no `Interviewer`
transcript at all in this setup.)

- [ ] **Step 4: Verify with the built-in speakers**

Switch output to the MacBook speakers and repeat.
Expected: their speech still appears under **Interviewer**, and — this is the
part echo cancellation is responsible for — it does **not** also appear as a
duplicate **You** line.

- [ ] **Step 5: Verify the failure is now visible**

Revoke the Screen Recording permission, restart the app, and click
**Start Listening**.
Expected: a toast appears (either the "needs Screen Recording permission" one or
"Couldn't capture system audio: … — continuing with mic only") instead of the
app looking healthy while mislabelling everything.

- [ ] **Step 6: Re-grant the permission**

Re-enable Screen Recording so the app is left in a working state.

- [ ] **Step 7: Commit nothing, report results**

No commit. Report which of Steps 3–5 passed. If Step 3 fails — no `Interviewer`
transcript on headphones — the flags did not take effect: re-check Task 2 Step 3
(the call must precede `app.whenReady()`), and confirm the running binary is the
freshly built one rather than a stale copy in `dist/`.
