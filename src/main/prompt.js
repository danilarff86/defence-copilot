'use strict';

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

// Question extraction (looks only at the most recent turns).
const EXTRACTION_SYSTEM =
  'You clean up noisy live transcripts of a dissertation defense. The transcript may contain repeats, cross-talk, speech-recognition errors and half-sentences. Identify the CURRENT core question a committee member is putting to the candidate and rewrite it as ONE clean, complete question. Drop introductory remarks, compliments and asides, but keep every meaningful part of a long multi-sentence question. If the latest turn is a short follow-up to an earlier question, return that follow-up rather than the earlier question. Preserve academic and technical terminology exactly as spoken. Output ONLY that question — no prefix, no quotes, no explanation. Write it in the SAME language the committee member is speaking.';

function buildExtractionUser(recentTranscript) {
  return `Recent turns:\n${recentTranscript}\n\nThe interviewer's current core question is:`;
}

module.exports = { buildPrompt, EXTRACTION_SYSTEM, buildExtractionUser };
