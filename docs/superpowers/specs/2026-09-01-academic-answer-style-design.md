# Academic Answer Style — Design

**Date:** 2026-09-01
**Status:** Approved (brainstormed in-session)

## Goal

Adapt this app's answer layer from a **job-interview** assistant to a
**dissertation-defense** assistant: answers should read as spoken academic
prose delivered to an examination committee, grounded in the candidate's own
dissertation materials — and must never be formatted as bullet lists.

The doctrine being ported comes from the sibling project
`~/pcworkspace/dissertation/assistant` (a spec-driven Python/PySide6
implementation of the same idea), specifically its answer prompt
`src/defense_assistant/infrastructure/llm/prompts/answer_v1.md` and its
spec `specs/001-defense-assistant/spec.md` (User Story 4, "Generate a
Dissertation-Grounded Answer with Evidence").

## Scope

**In scope:** the prompt/answer layer only — `src/main/prompt.js`, the
answer-length setting that constrains it, and the docs that describe the
answer style.

**Out of scope** (decided with the user):

- A switchable Interview / Defense mode. The app becomes single-purpose at
  the prompt level; UI labels are left alone.
- Renaming the Job Description setting to dissertation metadata, or any
  other Settings/UI restructuring.
- The sibling spec's evidence machinery — per-answer source excerpts and an
  evidence state (strongly / partially / insufficiently supported). That
  needs retrieval, IPC and renderer work.
- The sibling spec's "no reliable question detected" extraction outcome
  (US3, AC4). Useful only with renderer handling to stop the app answering a
  non-question; that is a UI change.

## Current state

- `src/main/prompt.js` — a dependency-free pure module exporting
  `buildPrompt()`, `EXTRACTION_SYSTEM` and `buildExtractionUser()`. Its
  system instruction is written in Chinese and casts the model as **a
  candidate in a job interview**. Rule 1 demands outline form verbatim:
  "【大纲式，不要整段散文】：第一行一句话给结论/判断；随后 2-3 个以'- '开头的
  精炼要点… 能用词组就别用整句" — one conclusion line plus 2–3 dash-prefixed
  points, phrases preferred over sentences, targeting ~300 characters. This
  is the direct cause of the list-formatted answers.
- `settings.js` — `maxChars: 500` default; `load()` merges the persisted
  `settings.json` over `DEFAULTS`, so a saved value always wins and there is
  no migration mechanism.
- `src/main/main.js:314-335` — calls `buildPrompt()` and derives Gemini's
  `maxOutputTokens` as `min(4096, max(160, ceil(maxChars * perChar * 1.15)))`
  with `perChar = 0.5` for English, `1.1` otherwise. OpenAI-compatible
  providers get a flat 4096 because they may be reasoning models.
- `src/renderer/app.js` — displays the answer via `textContent` (no Markdown
  rendering, which is why the prompt bans Markdown) and shows an
  `N / max chars` counter, with `500` hardcoded as a fallback in three
  places (lines 518, 571, 592).
- `test/prompt.test.js` — seven `node:test` cases, several of which assert
  the Chinese prompt strings (`/对话历史/`, `/250 字符以内/`,
  `/请用中文作答/`, `/最新\/当前/`, `/目标岗位 JD/`).

## Design

### 1. Prompt instructions move to English

The rewritten system instruction is written in **English**. Rationale: it is
maintainable for this repo's owner, neutral across the four supported
providers, and keeps the *answer* language independently controlled by the
`answerLanguage` setting rather than coupling the prompt to one output
language.

Exception: the per-language answer rules stay in their **target** language
(`Відповідай українською мовою.`, `请用中文作答。`, `Answer in English.`)
because writing the rule in the target language primes the output language.
Only the `auto` fallback branch is translated from Chinese to
`Answer in the same language the question was asked in.`

### 2. Persona and answering doctrine

The persona changes from "you are the candidate in a job interview" to "you
are the PhD candidate defending your own dissertation before an examination
committee, answering aloud." The rules are ported one-for-one from
`answer_v1.md`:

| Rule | Source |
|---|---|
| Flowing prose, ~3–8 sentences, no bullets/dashes/numbers/headings | `answer_v1.md` rule 1 + the spec's "normally 3–8 sentences" |
| Open with the direct answer; no preamble, no restating the question | `answer_v1.md` rule 1 |
| Dissertation excerpts are the primary, authoritative source of facts | `answer_v1.md` rule 2 |
| Reproduce numbers, formulas, algorithm names, constraints and experimental conditions **verbatim** | `answer_v1.md` rule 2 |
| General knowledge allowed but must be explicitly labelled as not a result of this dissertation | `answer_v1.md` rule 3 |
| Never invent dissertation-specific facts, figures, method names or references | `answer_v1.md` rule 4 |
| Report contradictions between excerpts instead of silently choosing one | `answer_v1.md` rule 5 |
| No relevant excerpt → short cautious general answer, stated as unconfirmed | `answer_v1.md` rule 6 |
| Never reveal reasoning | `answer_v1.md` rule 7 |

Carried over unchanged from the existing prompt: plain-text-only / no
Markdown, tolerance of speech-recognition noise, answer only the *current*
question, and the `profile` block as a highest-priority override.

The `jobDescription` block stays wired (its header is translated to English)
so the existing Settings feature keeps working; it is simply empty in
defense use.

### 3. Length: sentences primary, characters as a ceiling

`maxChars` stops being a target and becomes a stated hard upper bound; the
prompt asks for approximately 3–8 sentences. Because the character budget no
longer drives the shape of the answer, the default rises from **500 to
1200** — roughly what 3–8 sentences of Ukrainian academic prose occupies.

A persisted `settings.json` overrides `DEFAULTS`, so raising the default
alone would not reach existing installs. `settings.js` gains a
`schemaVersion` field and a `migrate()` step: on load, a settings file
predating this change (no `schemaVersion`) whose `maxChars` is still exactly
the old default of `500` is lifted to `1200`. Any other value is treated as
a deliberate user choice and left alone. The migrated value is persisted the
next time settings are saved; until then `migrate()` re-applies on every
load, which is idempotent.

`src/renderer/app.js`'s three hardcoded `500` fallbacks are replaced by one
`DEFAULT_MAX_CHARS = 1200` constant so the character counter and the
Settings field agree with the new default.

No change is needed to `main.js`'s token math: 1200 characters yields
`ceil(1200 * 1.1 * 1.15) = 1518` output tokens, comfortably inside the 4096
ceiling, and the formula already scales with `maxChars`.

### 4. Question extraction

`EXTRACTION_SYSTEM` is retuned from "interviewer" to a committee member and
gains the handling the sibling spec's User Story 3 calls for: drop
introductory remarks, preserve every meaningful part of a long multi-sentence
question, prefer a genuine short follow-up over the earlier question already
answered, and keep academic terminology exactly as spoken. It keeps its
existing contract — output only the question, in the speaker's language —
so `main.js`'s back-fill of the Current Question box is unaffected.
`buildExtractionUser()`'s trailing cue changes only its domain noun —
"The interviewer's current core question is:" becomes "The committee
member's ..." — because that cue is concatenated directly after
`EXTRACTION_SYSTEM` and would otherwise reintroduce the job-interview
framing the same request just dropped.

### 5. Documentation

`README.md:54` ("Concise, outline-style answers (default ≤ 500 chars)") and
its Chinese counterpart at `README.md:171` ("简洁的第一人称大纲式答案（默认
≤500 字）") both describe behaviour this change removes, and are updated to
describe grounded academic prose. A `CHANGELOG.md` entry goes under
`## [Unreleased] / ### Changed`.

## Testing

`test/prompt.test.js` is rewritten: the assertions on Chinese prompt strings
no longer apply. New coverage asserts the properties that matter rather than
exact wording where possible — that the prompt forbids lists, asks for
sentences, states the character ceiling, carries the grounding rules
(verbatim figures, no fabrication, labelled general knowledge, contradiction
reporting), and still injects context / question / transcript / profile /
job description. A new `test/settings.test.js` covers `migrate()`: a v1 file
at 500 is lifted, a v1 file with a user-chosen value is not, and an
already-migrated file is untouched.

Manual verification: run the app against a real Ukrainian defense question
with dissertation documents in the Knowledge Base, and confirm the answer is
continuous prose with no dash-prefixed lines.

## Risks

- **Longer answers cost more tokens and take longer to stream.** Accepted:
  it is inherent to the requested answer shape, and `maxChars` remains
  user-adjustable down to 50.
- **A model may still emit a list despite the ban.** Mitigated by stating the
  prohibition explicitly and positively ("flowing prose … continuous
  sentences") rather than only negatively. Not enforced in code; if it proves
  necessary, a post-processing strip is a follow-up, not part of this change.
- **The migration lifts a `maxChars` of 500 that a user set deliberately.**
  Accepted: 500 is indistinguishable from the old default, and the value
  stays editable in Settings.
