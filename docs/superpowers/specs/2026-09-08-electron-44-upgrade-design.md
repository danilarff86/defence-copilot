# Electron 44 Upgrade — Design

**Date:** 2026-09-08
**Status:** Approved (brainstormed in-session)
**Supersedes:** `2026-09-08-macos-system-audio-loopback-design.md`, whose central
premise was wrong. See *Why the previous attempt failed*.

## Goal

Make the **Interviewer** channel capture system audio on macOS by moving to an
Electron whose Chromium actually implements macOS system-audio capture, and by
declaring the Info.plist key that capture requires.

## Why the previous attempt failed

The previous design assumed Electron 33 could be made to capture system audio by
enabling two Chromium feature flags. It cannot. Searching the shipped binary
`Electron Framework.framework/Versions/Current/Electron Framework` (155 MB,
Electron 33.4.11) for the feature names finds nothing:

```
MacCatapSystemAudioLoopbackCapture       ABSENT
MacSckSystemAudioLoopbackOverride        ABSENT
MacLoopbackAudioForScreenShare           ABSENT
```

The method is sound — known features of the same binary (`MacWebContentsOcclusion`,
`ScreenCaptureKitStreamPickerSonoma`, `SpareRendererForSitePerProcess`) are all
found. No string containing `SystemAudio` exists in it at all.

Chromium **silently ignores unknown feature names** passed to `--enable-features`.
That is why the flags appear verbatim in the running process's arguments while
changing nothing:

```
--enable-features=MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride,
                  ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma
```

Electron 33's own typings state the position plainly
(`node_modules/electron/electron.d.ts:21334-21339`): loopback audio is
*"currently only supported on Windows."* The community library that supplied the
flag names targets a version range in which later Chromium builds gained them;
its range is not evidence about this binary.

## Scope

**In scope:** the Electron dependency version, the Info.plist declarations that
system-audio capture requires on both packaging paths, removal of the dead
feature-flag code from the superseded attempt, the Node floor the current
toolchain already needs, and the docs describing all of it.

**Out of scope** (decided with the user):

- Any change to the renderer's capture flow beyond deleting nothing from it. The
  `getDisplayMedia({ video: true, audio: true })` call, the
  `setDisplayMediaRequestHandler` answering `{ video: sources[0], audio: 'loopback' }`,
  and the dual-stream role assignment are all still correct on Electron 44 and
  stay untouched.
- Opting back into the older ScreenCaptureKit path via
  `disable-features=MacCatapLoopbackAudioForScreenShare`. CoreAudio Tap is the
  default and the recommended path on this user's macOS.
- Removing the BlackHole / virtual-device fallback from the README. It remains
  the answer for macOS 13–14.1, where CoreAudio Tap is unavailable.
- Notarization, a paid Developer ID, or CI release-matrix changes.
- Windows and Linux capture behaviour, which this change does not alter.

## Current state

- `package.json` — `"electron": "^33.2.0"`; installed 33.4.11. Latest stable
  Electron is **44.2.0**.
- The working tree carries the **uncommitted** superseded change: new
  `src/main/audioLoopback.js` and `test/audioLoopback.test.js`, the
  `applyLoopbackFeatureFlags()` wiring at `src/main/main.js:24-38`, the renderer
  edits, and README/CHANGELOG text describing the flags. Nothing is committed.
- `src/renderer/app.js:310` — `echoCancellation: true` (from the superseded
  change).
- `src/renderer/app.js:332-351` — `getSystemStream()` throws when no audio track
  survives (from the superseded change).
- **Two independent packaging paths, each with its own Info.plist source:**
  `extend-info.plist`, passed by the Makefile via
  `--extend-info=extend-info.plist` to `@electron/packager` (`make app`,
  `make universal`, `make run`); and `package.json` → `build.mac.extendInfo`,
  used by `electron-builder` (`npm run dist:mac`). Both currently declare
  `NSMicrophoneUsageDescription` and `NSScreenCaptureUsageDescription`, and
  **neither declares `NSAudioCaptureUsageDescription`**. They are maintained by
  hand and can drift apart unnoticed.
- `Makefile:17-18` — `ZIP_DIR := $(firstword $(wildcard .electron-cache/*/))`,
  passed as `--electron-zip-dir`. `.electron-cache/` currently holds exactly one
  zip: `electron-v33.4.11-darwin-arm64.zip`.
- `.nvmrc` says `20` and `package.json` `engines.node` says `>=18`, but the
  already-installed `@electron/packager@^20` declares `"node": ">= 22.12.0"`.
  The floor is stale today, independently of this change.
- `systemPreferences.getMediaAccessStatus()` accepts only `microphone`, `camera`
  and `screen` in Electron 44 — there is **no** media type for system-audio
  capture, so the audio permission's state cannot be queried from code.
- `src/main/main.js:169-188` — `setupDisplayMediaLoopback()`. Unchanged by this
  design; Electron 44 introduces no breaking change to
  `setDisplayMediaRequestHandler`, `desktopCapturer.getSources`, or
  `systemPreferences`.

## Design

### 1. Electron `^33.2.0` → `^44.2.0`

As of Electron v39.0.0-beta.4, Chromium made Apple's **CoreAudio Tap API** the
default for desktop audio capture on macOS. Electron 44 is therefore the first
*stable* major line at or above that floor that is also current, and it needs
**no feature flags at all** — the flag that exists in this area
(`MacCatapLoopbackAudioForScreenShare`) is for opting *out* of the new path, and
is documented as removed upstream and inert as of Electron 45.

Breaking changes across 34–44 that touch this app's surface are limited to:
Electron 44 requires **macOS 13+** (the README already claims macOS 13+, and the
user is on 26.6), and Electron 36 lowercases switches passed through
`app.commandLine`. The latter is a second, independent reason the superseded
flag code could never have worked as written, and it disappears with change 2.
Nothing else the app uses — `app`, `BrowserWindow`, `ipcMain`/`ipcRenderer`/
`contextBridge` under `contextIsolation: true`, `dialog`, `globalShortcut`,
`session.setDisplayMediaRequestHandler`, `desktopCapturer.getSources`,
`systemPreferences`, `shell`, `BrowserWindow.loadFile` — has a breaking change in
that range.

`.electron-cache/` must be cleared as part of the bump. The Makefile passes the
first subdirectory it finds there as `--electron-zip-dir`, and that directory
holds only the 33.4.11 zip; leaving it in place points the packager at the old
runtime and risks reproducing exactly the "I upgraded and nothing changed"
confusion this whole spec exists to end. The directory is gitignored and is a
pure download cache, so deleting it is free.

### 2. Delete the feature-flag module

`src/main/audioLoopback.js`, `test/audioLoopback.test.js`, the import at
`src/main/main.js:24`, and the `applyLoopbackFeatureFlags()` function and its
call at `src/main/main.js:26-38` are removed outright. On Electron 44 the flags
are unnecessary; on Electron 33 they were inert. Keeping code that looks like a
fix but is provably a no-op is worse than not having it.

The two renderer changes from the superseded attempt are **kept**, and change 3
explains why the second one becomes load-bearing rather than merely defensive.

### 3. Declare `NSAudioCaptureUsageDescription` on both packaging paths

On macOS 14.2 and higher the CoreAudio Tap path requires the
`NSAudioCaptureUsageDescription` Info.plist key for `desktopCapturer` to capture
audio. Electron's own documentation is explicit that when the key is absent,
audio-stream creation fails and **"no warnings or errors are displayed"** — the
same silent failure the user has been living with, arriving by a different route.
There is also no automatic fallback to the older ScreenCaptureKit path if tap
creation fails.

The key is added to **both** `extend-info.plist` and `package.json` →
`build.mac.extendInfo`, with identical wording, because the two packaging paths
read different files and a key added to only one produces an app that works when
built one way and silently fails when built the other.

Because that drift is invisible at runtime and Electron reports nothing, a unit
test enforces it: `test/packaging.test.js` parses both sources and asserts they
declare the same set of `NS*UsageDescription` keys, and that the set contains
`NSAudioCaptureUsageDescription`. This is the one property of this change that
*can* be tested automatically, and it guards precisely the failure mode that is
undetectable by hand.

`extend-info.plist` is parsed without a dependency: the test extracts `<key>`
names with a regular expression rather than adding a plist library, matching this
repo's no-new-dependencies constraint.

The existing `NSScreenCaptureUsageDescription` stays. `getDisplayMedia` is still
called with `video: true` — required for loopback to be granted at all — and
`desktopCapturer.getSources({ types: ['screen'] })` still enumerates screens, so
Screen Recording remains necessary alongside the new audio permission.

### 4. The renderer's audio-track guard becomes the only failure signal

`systemPreferences.getMediaAccessStatus()` has no media type for system audio, so
the app cannot ask macOS whether the audio-capture permission was granted. With
Electron documenting that a failed tap is silent, the guard added in the
superseded change — throw when `getSystemStream()` yields a stream with no audio
track, routing into the existing `handleSystemCaptureError` toast — is the only
thing standing between the user and another silent mislabelling session. It is
kept unchanged and its rationale is recorded here rather than left implicit.

The existing `getScreenPermission()` gate in `startListening` is also kept
unchanged: it guards the video half of the request, which is still required.

### 5. Node floor and documentation

`.nvmrc` goes from `20` to `22`, and `engines.node` from `>=18` to `>=22.12.0`,
matching what the already-installed `@electron/packager@^20` requires. This is a
pre-existing inaccuracy rather than something Electron 44 introduces, but it sits
directly in the build path this change asks people to re-run, and a contributor
following `.nvmrc` today cannot package the app at all.

README changes: the Requirements line and the Platform support table state that
the app needs macOS 13+ to run but **macOS 14.2+ for system-audio capture**, that
the permission appears as "Screen & System Audio Recording", and that macOS
13–14.1 users need the existing BlackHole fallback. The CHANGELOG entry written
by the superseded attempt is replaced — it currently describes the feature flags
as the fix, which is false — with one describing the Electron upgrade.

## Testing

`test/packaging.test.js` (new, `node:test`) covers the Info.plist invariant from
change 3: both sources declare `NSAudioCaptureUsageDescription`; both declare the
same set of `NS*UsageDescription` keys; and the descriptions are non-empty
strings (macOS shows them in the permission prompt, and an empty string is a
silently bad prompt).

`test/audioLoopback.test.js` is deleted with its module. The remaining suites
(`prompt`, `settings`, `documents`, `llm`, `sse`, `store`) are pure modules
untouched by an Electron version change and must continue to pass unchanged.

No automated test can prove system audio is captured — it needs a real macOS
permission grant, a real audio source, and a GUI. That is manual, and it is the
only thing that actually closes this bug:

1. `rm -rf .electron-cache dist`, `npm install`, `make app`.
2. Replace the copy at `/Applications/Real Time Interview Copilot.app` — the
   user's TCC grants are attached to that path, and a stale copy there is what
   gets launched.
3. Grant both **Screen & System Audio Recording** and, when macOS prompts for it,
   system-audio recording. The ad-hoc signature changes on every build, so macOS
   treats each build as a new binary and prior grants do not carry over.
4. With **headphones**: the other party's speech appears under `Interviewer`, and
   nothing appears under `You` while they speak.
5. With **built-in speakers**: the same, and no duplicate `You` line.
6. Revoke the permission and confirm a toast appears rather than a healthy-looking
   session.

## Risks

- **A major-version jump of 11 releases.** Mitigated by how small and stable this
  app's Electron surface is — ten imported APIs, none with a breaking change in
  the 34–44 range — and by the fact that the full unit suite plus a real launch
  are both cheap to run. If the app fails to boot, the bisect space is the eleven
  majors, not the codebase.
- **Chromium 44's renderer may change layout or media behaviour subtly.** The UI
  is a single static HTML file with no framework; visual regressions would be
  obvious on first launch and are covered by the manual verification.
- **CoreAudio Tap requires macOS 14.2+, so this fixes nothing for macOS 13–14.1
  users.** Accepted: those users keep the BlackHole fallback, which change 5
  documents explicitly rather than leaving them to discover it.
- **The Info.plist sync test asserts equality of key sets, so adding a key to one
  file deliberately will fail the suite.** Intended — the failure is the prompt to
  add it to both, which is exactly the drift being prevented.
- **`electron-builder@26` and `@electron/packager@20` are not pinned to Electron
  44.** Both resolve the Electron version from the installed dependency rather
  than bundling one, and neither declares an upper bound. If either tool breaks on
  44, the fallback is to package with the other, since the repo supports both.
