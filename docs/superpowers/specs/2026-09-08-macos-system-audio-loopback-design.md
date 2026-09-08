# macOS System-Audio Loopback — Design

**Date:** 2026-09-08
**Status:** Approved (brainstormed in-session)

## Goal

Make the **Interviewer** channel actually capture system audio on macOS. Today
it captures nothing: the interviewer's speech either disappears entirely (when
the user wears headphones) or leaks into the microphone and is transcribed
under the **You** label (when the user listens on the built-in speakers).

## Scope

**In scope:** the audio-capture path — the Chromium feature flags that unlock
loopback capture, the microphone constraints that let speaker output be
mistaken for the candidate, the renderer's silent-failure behaviour when the
system stream carries no audio, and the docs that describe platform support.

**Out of scope** (decided with the user):

- Upgrading Electron to 39+, where loopback is supported natively without
  flags. A major-version bump of the runtime is a separate change with its own
  risk surface; the flags work on the pinned Electron 33.
- Bundling `electron-audio-loopback` as a dependency. This repo needs only the
  flag list from it, not its IPC layer — the existing
  `setupDisplayMediaLoopback()` handler is already shape-identical to the
  library's.
- The Core Audio Taps path (`MacCatapSystemAudioLoopbackCapture`, or
  AudioTee.js). It captures pre-mixer audio and needs only the narrower
  "System Audio Recording Only" permission, but it is the newer and less
  proven of the two Chromium paths.
- Any UI work: a dedicated per-channel capture indicator, a device picker
  redesign, or surfacing the loopback state in the status bar.
- Speaker-diarization or cross-channel de-duplication to catch mislabelled
  speech after the fact. Fixing the capture removes the cause.

## Current state

- `src/main/main.js:169-188` — `setupDisplayMediaLoopback()` registers
  `session.defaultSession.setDisplayMediaRequestHandler` and answers with
  `callback({ video: sources[0], audio: 'loopback' })`. This is the correct
  shape.
- `src/main/main.js` has **no `app.commandLine.appendSwitch` call anywhere**.
  This is the defect. The installed Electron's own typings
  (`node_modules/electron/electron.d.ts:21334-21339`) state: *"Specifying a
  loopback device will capture system audio, and is currently only supported on
  Windows."* On macOS the handler therefore resolves with a video-only stream
  and the audio track is silently absent.
- `src/renderer/app.js:333-339` — `getSystemStream()` requests
  `getDisplayMedia({ video: true, audio: true })`, stops the video tracks, and
  returns the stream **without checking that an audio track survived**. A
  video-only stream is treated as success.
- `src/renderer/app.js:305-313` — `getMicStream()` sets
  `echoCancellation: false` explicitly, so the microphone transcribes whatever
  the speakers play.
- `src/renderer/app.js:406` / `:417` — the microphone stream is hardwired to
  the `interviewee` role (rendered as **You**, `app.js:105`) and the system
  stream to `interviewer`. The roles are per-stream, so any speech reaching the
  mic is attributed to the candidate by construction.
- `src/renderer/app.js:388-398` — when system capture throws, `startListening`
  toasts and continues mic-only. Correct as a fallback, but unreachable in the
  video-only case above, so the user gets no signal at all.
- `extend-info.plist` already declares `NSScreenCaptureUsageDescription`, and
  `main.js:387` reads `systemPreferences.getMediaAccessStatus('screen')`. The
  permission plumbing is in place and needs no change.
- `README.md:110` claims macOS system audio works via "Screen-Capture
  loopback", and `README.md:59` calls macOS the most seamless platform. Both
  describe behaviour the code does not currently deliver.

### Why both reported symptoms follow from one cause

| User setup | Observed | Explanation |
|---|---|---|
| Headphones | No `Interviewer` transcript at all | Loopback yields no audio; the mic cannot hear headphones. |
| Built-in speakers | Interviewer's speech appears as `You` | Loopback yields no audio; the mic hears the speakers, and the mic channel is labelled `You`. |

## Design

### 1. Enable the Chromium loopback feature flags

Loopback capture on macOS 13.2+ is gated behind two Chromium features that
must be enabled on the command line **before app ready**:
`MacLoopbackAudioForScreenShare` (the general screen-share loopback path) and
`MacSckSystemAudioLoopbackOverride` (routes it through ScreenCaptureKit). Linux
has an equivalent, `PulseaudioLoopbackForScreenShare`. Windows needs none — its
support is native, which is exactly what the Electron typings describe. Flag
names and the darwin/linux split follow
[`alectrocute/electron-audio-loopback`](https://github.com/alectrocute/electron-audio-loopback/blob/main/src/config.ts),
the reference implementation for Electron 31.0.1–38.x.

A new dependency-free module `src/main/audioLoopback.js` owns the flag list and
exports a pure `buildLoopbackFeatures({ platform, existing })`. Keeping the
logic out of `main.js` follows this repo's existing pattern (`prompt.js`,
`config.js`) and makes it reachable from `node --test`, which cannot boot
Electron. It returns `null` for platforms needing no flags, so the caller has a
single unambiguous "nothing to do" signal.

The function merges rather than overwrites: it preserves any `enable-features`
value already present on the command line (a user's `--enable-features=…`, or
another switch set elsewhere) and appends only the required flags that are
missing. `main.js` calls it at module scope — before `app.whenReady()` — reads
the current value with `app.commandLine.getSwitchValue`, removes the switch if
present, and re-appends the merged value.

### 2. Enable echo cancellation on the microphone

`echoCancellation` flips from `false` to `true`. Without this, the fix above is
only half a fix: with loopback working and the meeting playing through the
built-in speakers, the interviewer's voice still reaches the microphone and
still renders as **You**, alongside a now-correct `Interviewer` line. Echo
cancellation references the system output and suppresses exactly that path.

`noiseSuppression: true` stays as it is.

### 3. Fail loudly instead of returning a silent stream

`getSystemStream()` gains a post-condition: after the video tracks are stopped
they are also removed from the stream (the reference implementation does both;
a stopped-but-attached track is still enumerable), and if no audio track
remains the remaining tracks are stopped and an `Error` is thrown. Throwing —
rather than returning `null` — routes the failure into `startListening`'s
existing `catch` and `handleSystemCaptureError`, which already distinguishes
"Screen Recording not granted" from other causes and already tells the user the
session is continuing mic-only. No new error-handling branch is introduced.

This turns the current failure mode — a session that looks healthy while
mislabelling every word the interviewer says — into a visible one.

### 4. Documentation

`README.md:110`'s macOS row and `README.md:59` are left claiming loopback
works, because after this change they are true; the row gains a note that the
permission is "Screen Recording", which on recent macOS is presented as
"Screen & System Audio Recording". A `CHANGELOG.md` entry goes under
`## [Unreleased]` / `### Fixed`.

## Testing

`test/audioLoopback.test.js` (new, `node:test`, matching the existing suites)
covers `buildLoopbackFeatures` as a pure function: darwin produces both macOS
flags; linux produces the PulseAudio flag; win32 and unknown platforms produce
`null`; an existing value is preserved and the required flags appended; a flag
already present is not duplicated; and empty, whitespace-only, and absent
`existing` values are all handled.

The `main.js` wiring and the renderer changes have no test harness in this repo
(there is no Electron-runtime or DOM test setup, and none is added here), so
they are verified manually:

1. Rebuild and re-sign the app (`make app`) — the ad-hoc signature changes on
   every build, so macOS treats it as a new binary and the Screen Recording
   grant must be re-issued under System Settings → Privacy & Security.
2. With **headphones**, start a Teams call and confirm the other party's speech
   appears under `Interviewer` and nothing appears under `You` while they talk.
3. With **built-in speakers**, confirm the same, and specifically that the
   interviewer's speech no longer produces a duplicate `You` line.
4. Revoke Screen Recording and confirm the app now surfaces a toast and falls
   back to mic-only rather than appearing to work.

## Risks

- **Echo cancellation may degrade microphone quality.** Chromium's AEC puts the
  input into a voice-processing mode with a narrower response. Accepted: the
  audio's only consumer is speech-to-text, which AEC is tuned for, and
  correctly separated speakers matter more here than fidelity.
- **macOS shows a screen-recording indicator although only audio is captured.**
  Inherent to the ScreenCaptureKit path — `getDisplayMedia` must request
  `video: true` for loopback to work at all, even though the video track is
  discarded immediately. Documented in the README rather than worked around.
- **The flag names are undocumented Chromium internals.** They can be renamed
  or removed in a future Chromium, which would silently return the app to
  today's behaviour. Mitigated by change 3: the failure becomes visible instead
  of silent. The durable fix is Electron 39+, which is out of scope here.
- **Flags are ignored if set after app ready.** Mitigated by calling at module
  scope and by keeping the call in a named function directly beneath the
  `require` block, where its ordering constraint is stated in a comment.
