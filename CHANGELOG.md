# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Ukrainian language support**: `Українська` is now selectable as the transcript language (Deepgram `nova-3`, `language=uk`) and as the answer language (answers generated in Ukrainian). Ukrainian documents in the Knowledge Base were already supported and are now covered by tests.
- **Windows & Linux support for running**: npm scripts are now cross-platform (`cross-env`), so `npm start` works on Windows (previously the `VAR=` prefix broke cmd). `make run` adapts to the OS — macOS builds & opens the signed app; Windows/Linux launch via `npm start`. Prebuilt `.exe` (Windows) and `.AppImage` (Linux) ship in Releases.

### Fixed
- **Sentences are no longer split at the slightest pause.** The transcript treated Deepgram's `is_final` flag as end-of-sentence, but that flag only means "this chunk won't be revised" — Deepgram emits several per spoken sentence. One question therefore arrived as two or three separate turns, and the fragments were then handed to the LLM, which stitched them into a garbled question. Frozen chunks are now buffered and committed as a single turn on `speech_final` (true end of speech), with `utterance_end_ms` as a backstop for when background noise stops endpointing from firing, and a flush on stop so a trailing sentence isn't dropped.
- **System audio is now actually captured on macOS.** The Chromium shipped in Electron 33 had no macOS system-audio capture at all, so `getDisplayMedia` handed back a stream with no usable audio: on headphones the interviewer was never transcribed, and on speakers their speech reached only the microphone and was labelled **You**. The app now runs on Electron 44, whose Chromium captures system audio through Apple's CoreAudio Tap API (macOS 14.2+), and declares the `NSAudioCaptureUsageDescription` permission that API requires. The microphone also runs with echo cancellation so speaker output no longer bleeds into the candidate channel, and a system stream that arrives without an audio track now raises a visible error instead of silently degrading to mic-only.
- System-audio capture without Screen Recording permission now fails quietly with a clear prompt instead of throwing `Failed to get sources` / `Video was requested…` unhandled rejections. When the permission is already denied, the app skips the capture attempt and guides you to grant it (continuing mic-only).

### Changed
- **Sentence pause is now configurable** under Settings → Sentence pause: Short (0.5s), Normal (0.9s, the new default) or Long (1.5s) of silence before a sentence is treated as finished. The previous behaviour was a fixed 0.3s, which cut off anyone who paused to think. Auto-answer's own debounce dropped from 1.3s to 0.6s to compensate, so the time from question to answer is about what it was.
- **Academic answer style**: answers are now flowing spoken prose (about 3–8 sentences) instead of the previous outline form with `- ` bullet points, and are cast as a dissertation-defense reply rather than a job-interview reply. The prompt now treats your Knowledge Base as the authoritative source, reproduces numbers, formulas, algorithm names and experimental conditions verbatim, labels anything drawn from general knowledge, reports contradictions between sources, and refuses to invent facts or references. Question extraction targets a committee member's current question, dropping preambles and preferring a genuine follow-up over an already-answered question.
- **Answer length default raised** from 500 to 1200 characters, since character count is now a hard ceiling rather than a target. Existing installs still on the old 500 default are migrated automatically (a length you chose yourself is kept); adjust it any time under Settings → Max characters.
- Renamed the app (display name) to **Real Time Interview Copilot**. The npm package, bundle id (`com.interview.copilot`), repo slug, and local data directory are unchanged, so existing settings/keys/JD/Knowledge Base are preserved.

### Added
- **App icon**: a native-style macOS icon (rust squircle + microphone), generated from `build/icon.svg` via `npm run icon` and applied to packaged builds and the dev dock.
- **Auto-answer mode**: an optional toggle that detects when the interviewer finishes a question (pause debounce + question heuristic) and generates the answer automatically — no hotkey needed.
- **Persistent Knowledge Base**: uploaded/pasted documents are now saved to `userData/knowledge.json` and reloaded on launch; add / remove / update / clear all persist. (Previously in-memory only.)
- **Job-description customization**: paste or upload a JD (txt/md/pdf/docx) in Settings; it's persisted and injected into every answer so responses are tailored to the target role.
- Open-source hardening: LICENSE (MIT), bilingual README with disclaimer & privacy notes, CONTRIBUTING, SECURITY, issue/PR templates.
- Multi-provider answer generation: **OpenAI** and **Ollama** (local) in addition to DeepSeek and Gemini, via a shared OpenAI-compatible client and a provider registry (`config.js`).
- Unit tests (`node:test`) for prompt building, provider fallback/retry, document chunking, knowledge store, and SSE parsing.
- ESLint (flat config) + Prettier.
- `electron-builder` packaging (dmg / nsis / AppImage, x64 + arm64) and GitHub Actions (CI + release).
- Content-Security-Policy in the renderer.
- `.nvmrc`, `engines`, `.env.example`.

### Changed
- Answers are now grounded in the last ~15 turns of dialogue, while question detection uses only the latest turns.
- Extracted prompt building into `prompt.js` and the OpenAI-compatible client into `openaiCompat.js` for testability and reuse.

## [1.0.0]
- Initial app: Deepgram dual-channel transcription, Ctrl+A question detection + answer generation, knowledge base, switchable DeepSeek/Gemini providers, outline-style answers, packaged macOS app.
