'use strict';

const $ = (id) => document.getElementById(id);

// Keep in sync with DEFAULTS.maxChars in src/main/settings.js.
const DEFAULT_MAX_CHARS = 1200;

const state = {
  listening: false,
  settings: null,
  // Capture resources
  contexts: [],
  nodes: [],
  streams: [],
  dgMic: null,
  dgSys: null,
  // Transcription
  interim: { interviewer: null, interviewee: null },
  lastFinalSpeaker: null,
  history: [], // Finalized conversation turns (deduped): { role, text }
  sessionStart: null,
  autoQuestion: '', // The question last auto-recognized and filled into the question box (treated as "empty" if the user hasn't changed it)
  autoTimer: null, // Debounce timer for auto-answer
  lastAutoKey: null, // The question that was last auto-answered (deduped to avoid firing twice)
  // Generation
  reqId: 0,
  generating: false,
};

// ---------------- Utilities ----------------
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function setStatus(text, kind) {
  $('statusText').textContent = text;
  const dot = $('statusDot');
  dot.classList.remove('live', 'error');
  if (kind) dot.classList.add(kind);
}

function charCount(s) {
  return [...(s || '')].length;
}

// ---------------- Transcript display ----------------
const MIC_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

function showEmptyState() {
  $('transcript').innerHTML =
    `<div class="transcript-empty"><div class="empty-mic">${MIC_SVG}</div>` +
    '<p>Once you start listening, the conversation between the interviewer and candidate will appear here.</p></div>';
}

function clearEmptyState() {
  const e = $('transcript').querySelector('.transcript-empty');
  if (e) e.remove();
}

function setLive(on) {
  $('liveIndicator').classList.toggle('hidden', !on);
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function addDaySeparator() {
  const t = $('transcript');
  const sep = document.createElement('div');
  sep.className = 'day-sep';
  const clock = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  sep.textContent = `Today · ${clock}`;
  t.appendChild(sep);
}

function isQuestion(text) {
  return (
    /[?？]/.test(text) ||
    /^(what|why|how|when|where|who|which|can you|could you|tell me|walk me|describe|explain|do you|have you|would you)\b/i.test(
      text.trim(),
    )
  );
}

function avatarEl(role) {
  const a = document.createElement('div');
  a.className = role === 'interviewee' ? 'avatar you-av' : 'avatar';
  a.textContent = role === 'interviewee' ? 'YOU' : 'IV';
  return a;
}

function metaEl(role, rightText) {
  const m = document.createElement('div');
  m.className = 'msg-meta';
  const who = `<span class="who">${role === 'interviewee' ? 'You' : 'Interviewer'}</span>`;
  const ts = `<span class="ts">${rightText}</span>`;
  m.innerHTML = role === 'interviewee' ? `${ts} ${who}` : `${who} ${ts}`;
  return m;
}

function appendFinalLine(role, text) {
  clearEmptyState();
  const t = $('transcript');
  const elapsed = formatElapsed(state.sessionStart ? Date.now() - state.sessionStart : 0);

  const msg = document.createElement('div');
  msg.className = `msg ${role === 'interviewee' ? 'you' : 'interviewer'}`;

  const main = document.createElement('div');
  main.className = 'msg-main';
  main.appendChild(metaEl(role, elapsed));

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  main.appendChild(bubble);

  if (role === 'interviewer' && isQuestion(text)) {
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg> Question detected';
    main.appendChild(badge);
  }

  msg.appendChild(avatarEl(role));
  msg.appendChild(main);
  t.appendChild(msg);
  t.scrollTop = t.scrollHeight;
}

function updateInterim(role, text) {
  clearEmptyState();
  const t = $('transcript');
  let el = state.interim[role];
  if (!el) {
    el = document.createElement('div');
    el.className = `msg ${role === 'interviewee' ? 'you' : 'interviewer'} interim`;
    const main = document.createElement('div');
    main.className = 'msg-main';
    main.appendChild(metaEl(role, 'live'));
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    main.appendChild(bubble);
    el.appendChild(avatarEl(role));
    el.appendChild(main);
    t.appendChild(el);
    state.interim[role] = el;
  }
  el.querySelector('.bubble').textContent = text;
  t.scrollTop = t.scrollHeight;
}

function clearInterim(role) {
  const el = state.interim[role];
  if (el) {
    el.remove();
    state.interim[role] = null;
  }
}

function normalizeText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();
}

// Writes a finalized sentence into history, and dedupes against cross-channel bleed / ASR repeats
function pushHistory(role, text) {
  const norm = normalizeText(text);
  if (!norm) return;
  const recent = state.history.slice(-3);
  for (const h of recent) {
    const hn = normalizeText(h.text);
    if (hn === norm || hn.includes(norm) || norm.includes(hn)) {
      // Near-duplicate: keep whichever line carries more information
      if (norm.length > hn.length) {
        h.text = text;
        h.role = role;
      }
      return;
    }
  }
  state.history.push({ role, text });
  if (state.history.length > 60) state.history.shift();
}

// Take the most recent turns of the conversation (deduped) and hand them to the LLM to extract the question
function buildRecentDialogue(maxItems = 12) {
  return state.history
    .slice(-maxItems)
    .map((h) => `${h.role === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${h.text}`)
    .join('\n');
}

// Render "Control+A" as key chips like ⌃Control / A
function renderHotkeyHint(hotkey) {
  const sym = {
    control: '⌃ Control',
    command: '⌘',
    cmd: '⌘',
    commandorcontrol: '⌘/⌃',
    shift: '⇧ Shift',
    alt: '⌥ Option',
    option: '⌥ Option',
  };
  const chips = (hotkey || 'Control+A')
    .split('+')
    .map((t) => `<kbd>${sym[t.toLowerCase()] || t}</kbd>`)
    .join(' ');
  $('hotkeyHint').innerHTML = chips;
}

function handleTranscript(role, { text, isFinal }) {
  if (!isFinal) {
    updateInterim(role, text);
    return;
  }
  clearInterim(role);
  appendFinalLine(role, text);
  pushHistory(role, text);
  state.lastFinalSpeaker = role;
  scheduleAuto(role);
}

// ---------------- Auto-answer (fires when a question is detected) ----------------
const AUTO_DELAY_MS = 1300; // A pause this long from the interviewer ≈ they finished asking a question

function scheduleAuto(role) {
  clearTimeout(state.autoTimer);
  if (!state.settings.autoAnswer || !state.listening) return;
  if (role === 'interviewee') return; // You spoke → cancel the pending auto-answer
  // Reset the debounce every time the interviewer finishes a sentence; treat
  // it as a finished question after a pause of AUTO_DELAY_MS.
  state.autoTimer = setTimeout(maybeAutoAnswer, AUTO_DELAY_MS);
}

function maybeAutoAnswer() {
  if (!state.settings.autoAnswer || !state.listening || state.generating) return;
  // Current question turn = interviewer content after the last time "You" spoke
  let lastYou = -1;
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i].role === 'interviewee') {
      lastYou = i;
      break;
    }
  }
  const turnText = state.history
    .slice(lastYou + 1)
    .filter((h) => h.role === 'interviewer')
    .map((h) => h.text)
    .join(' ')
    .trim();
  if (turnText.length < 15 || !isQuestion(turnText)) return;
  const key = normalizeText(turnText);
  if (key === state.lastAutoKey) return; // Already auto-answered this turn
  state.lastAutoKey = key;
  triggerGenerate();
}

// ---------------- Audio capture ----------------
async function listInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');

    const micSel = $('micSelect');
    const sysSel = $('sysSelect');
    const prevMic = micSel.value;
    const prevSys = sysSel.value;

    micSel.innerHTML = '';
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      micSel.appendChild(opt);
    });
    if (prevMic) micSel.value = prevMic;

    // System audio source: keep the loopback option and append optional input devices (e.g. BlackHole)
    sysSel.innerHTML = '<option value="__loopback__">System Audio (Loopback)</option>';
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Input ${i + 1}`;
      sysSel.appendChild(opt);
    });
    if (prevSys) sysSel.value = prevSys;
  } catch (e) {
    console.error(e);
  }
}

async function getMicStream(deviceId) {
  const audio = deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true;
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(typeof audio === 'object' ? audio : {}),
      // Enable echo cancellation: otherwise, when audio plays through speakers, the microphone picks up the other party's voice and it gets labelled You.
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
}

async function handleSystemCaptureError(e, sysVal) {
  if (sysVal === '__loopback__') {
    const status = await window.api.getScreenPermission();
    if (status !== 'granted') {
      toast(
        'System audio needs Screen Recording permission. Opening Settings — enable “Electron”, then restart the app.',
        true,
      );
      setStatus('Grant Screen Recording, then restart', 'error');
      window.api.openScreenSettings();
      return;
    }
  }
  toast('Couldn’t capture system audio: ' + e.message + ' — continuing with mic only', true);
}

async function getSystemStream(value) {
  if (value === '__loopback__') {
    // Captures system audio via the main process's displayMediaRequestHandler.
    // video: true must be requested or loopback fails outright — the video track is discarded immediately after.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    // No audio track means the capture didn't take effect — most likely a
    // missing permission. Electron reports nothing when a CoreAudio Tap fails,
    // and getMediaAccessStatus has no media type for system audio, so this
    // check is the app's only signal that it happened.
    // This must throw, or it silently falls back to mic-only and labels the
    // interviewer's speech as You.
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('system audio returned no audio track');
    }
    return stream;
  }
  return navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: value } } });
}

async function wireStream(stream, dg) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, 'pcm-worklet');
  // Connect a silent gain node to destination, to keep the worklet processing continuously without producing an echo
  const silent = ctx.createGain();
  silent.gain.value = 0;

  worklet.port.onmessage = (e) => dg.send(e.data);

  source.connect(worklet);
  worklet.connect(silent);
  silent.connect(ctx.destination);

  state.contexts.push(ctx);
  state.nodes.push(source, worklet, silent);
  // dg's expected sample rate follows the actual AudioContext
  dg.sampleRate = ctx.sampleRate;
}

function setListeningUI(on) {
  const btn = $('toggleBtn');
  btn.classList.toggle('primary', !on);
  btn.classList.toggle('danger', on);
  btn.querySelector('.label').textContent = on ? 'Stop Listening' : 'Start Listening';
  const icon = on
    ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  btn.querySelector('svg').outerHTML = icon;
}

async function startListening() {
  if (!state.settings.deepgramApiKey) {
    toast('Add your Deepgram API key in Settings first', true);
    openSettings();
    return;
  }

  setStatus('Initializing…');
  try {
    await window.api.ensureMicPermission();

    const micStream = await getMicStream($('micSelect').value);
    let sysStream = null;
    const sysVal = $('sysSelect').value;
    try {
      // Loopback needs Screen Recording permission: if it's already been
      // explicitly denied, guide the user directly instead of calling
      // getDisplayMedia (which would just produce a string of errors).
      if (sysVal === '__loopback__' && (await window.api.getScreenPermission()) === 'denied') {
        await handleSystemCaptureError(new Error('Screen Recording permission denied'), sysVal);
      } else {
        sysStream = await getSystemStream(sysVal);
      }
    } catch (e) {
      console.error('system audio capture failed:', e);
      await handleSystemCaptureError(e, sysVal);
    }

    const lang = state.settings.sttLanguage || 'en-US';

    state.dgMic = new window.DeepgramLive({
      apiKey: state.settings.deepgramApiKey,
      language: lang,
      onTranscript: (r) => handleTranscript('interviewee', r),
      onState: (s, info) => onDgState('mic', s, info),
    });
    await wireStream(micStream, state.dgMic);
    state.streams.push(micStream);
    state.dgMic.connect();

    if (sysStream) {
      state.dgSys = new window.DeepgramLive({
        apiKey: state.settings.deepgramApiKey,
        language: lang,
        onTranscript: (r) => handleTranscript('interviewer', r),
        onState: (s, info) => onDgState('sys', s, info),
      });
      await wireStream(sysStream, state.dgSys);
      state.streams.push(sysStream);
      state.dgSys.connect();
    }

    state.listening = true;
    state.sessionStart = Date.now();
    state.lastAutoKey = null;
    clearEmptyState();
    if (!$('transcript').querySelector('.day-sep')) addDaySeparator();
    setLive(true);
    setListeningUI(true);
    setStatus('Listening', 'live');
    // Refresh device names now that permission has been granted
    listInputDevices();
  } catch (e) {
    console.error(e);
    setStatus('Failed to start', 'error');
    toast('Failed to start: ' + e.message, true);
    await stopListening();
  }
}

function onDgState(which, s, info) {
  if (s === 'error') {
    setStatus('Transcription error', 'error');
    if (info) toast(`Deepgram (${which}): ${info}`, true);
  }
}

async function stopListening() {
  state.listening = false;
  clearTimeout(state.autoTimer);
  try {
    if (state.dgMic) state.dgMic.close();
  } catch (_e) {}
  try {
    if (state.dgSys) state.dgSys.close();
  } catch (_e) {}
  state.dgMic = null;
  state.dgSys = null;

  state.nodes.forEach((n) => {
    try {
      n.disconnect();
    } catch (_e) {}
  });
  state.nodes = [];
  for (const c of state.contexts) {
    try {
      await c.close();
    } catch (_e) {}
  }
  state.contexts = [];
  state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  state.streams = [];

  clearInterim('interviewer');
  clearInterim('interviewee');
  setLive(false);
  setListeningUI(false);
  setStatus('Idle');
}

// ---------------- Generate an answer ----------------
function triggerGenerate() {
  let manual = $('questionBox').value.trim();
  // If the box only holds the previously auto-recognized question (the user
  // hasn't edited it), still treat it as "auto-extract from recent conversation."
  if (manual && manual === state.autoQuestion) manual = '';
  // Answer context: the last 15 turns of conversation history (question
  // detection in the main process only looks at its final few turns)
  const transcript = buildRecentDialogue(15);
  if (!manual && !transcript) {
    toast('Nothing to answer yet — start listening or type a question', true);
    $('questionBox').focus();
    return;
  }
  state.reqId += 1;
  state.generating = true;
  const ans = $('answer');
  ans.textContent = '';
  ans.classList.add('generating');
  updateCounter('');
  $('generateBtn').disabled = true;
  $('cancelBtn').disabled = false;
  if (!manual) {
    const turns = transcript.split('\n').length;
    toast(`Detecting the question from the last ${turns} turns…`);
  }
  // manual empty → let Gemini extract the question from recent conversation before answering; non-empty → answer that question directly
  window.api.generateAnswer({ reqId: state.reqId, question: manual, transcript });
}

function endGenerate() {
  state.generating = false;
  $('answer').classList.remove('generating');
  $('generateBtn').disabled = false;
  $('cancelBtn').disabled = true;
}

function updateCounter(text) {
  const n = charCount(text);
  const max = state.settings ? state.settings.maxChars || DEFAULT_MAX_CHARS : DEFAULT_MAX_CHARS;
  const el = $('charCounter');
  el.textContent = `${n} / ${max} chars`;
  el.classList.toggle('over', n > max);
}

// ---------------- Documents ----------------
async function refreshDocs(list) {
  const docs = list || (await window.api.listDocuments());
  const ul = $('docList');
  ul.innerHTML = '';
  if (!docs || docs.length === 0) {
    const li = document.createElement('li');
    li.className = 'docs-empty';
    li.textContent =
      'No materials yet. Upload a résumé, job description, or notes — answers will reference these first.';
    ul.appendChild(li);
    return;
  }
  docs.forEach((d) => {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.className = 'doc-name';
    left.textContent = d.name;
    const meta = document.createElement('span');
    meta.className = 'doc-meta';
    meta.textContent = `${d.chars.toLocaleString()} chars`;
    left.appendChild(meta);
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = 'Remove';
    rm.onclick = async () => refreshDocs(await window.api.removeDocument(d.id));
    li.appendChild(left);
    li.appendChild(rm);
    ul.appendChild(li);
  });
}

// ---------------- Settings modal ----------------
function openSettings() {
  const s = state.settings;
  $('setDeepgram').value = s.deepgramApiKey || '';
  $('setProvider').value = s.provider || 'gemini';
  $('setDeepseek').value = s.deepseekApiKey || '';
  $('setDeepseekModel').value = s.deepseekModel || 'deepseek-chat';
  $('setGemini').value = s.geminiApiKey || '';
  $('setModel').value = s.genModel || 'gemini-2.5-flash';
  $('setOpenai').value = s.openaiApiKey || '';
  $('setOpenaiModel').value = s.openaiModel || 'gpt-4o-mini';
  $('setOllamaURL').value = s.ollamaBaseURL || 'http://localhost:11434/v1/chat/completions';
  $('setOllamaModel').value = s.ollamaModel || 'llama3.1';
  $('setSttLang').value = s.sttLanguage || 'en-US';
  $('setAnswerLang').value = s.answerLanguage || 'auto';
  $('setMaxChars').value = s.maxChars || DEFAULT_MAX_CHARS;
  $('setHotkey').value = s.hotkey || 'Control+A';
  $('setProfile').value = s.interviewProfile || '';
  $('setJD').value = s.jobDescription || '';
  $('settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  const partial = {
    deepgramApiKey: $('setDeepgram').value.trim(),
    provider: $('setProvider').value,
    deepseekApiKey: $('setDeepseek').value.trim(),
    deepseekModel: $('setDeepseekModel').value.trim() || 'deepseek-chat',
    geminiApiKey: $('setGemini').value.trim(),
    genModel: $('setModel').value.trim() || 'gemini-2.5-flash',
    openaiApiKey: $('setOpenai').value.trim(),
    openaiModel: $('setOpenaiModel').value.trim() || 'gpt-4o-mini',
    ollamaBaseURL: $('setOllamaURL').value.trim() || 'http://localhost:11434/v1/chat/completions',
    ollamaModel: $('setOllamaModel').value.trim() || 'llama3.1',
    sttLanguage: $('setSttLang').value,
    answerLanguage: $('setAnswerLang').value,
    maxChars: parseInt($('setMaxChars').value, 10) || DEFAULT_MAX_CHARS,
    hotkey: $('setHotkey').value.trim() || 'Control+A',
    interviewProfile: $('setProfile').value,
    jobDescription: $('setJD').value,
  };
  state.settings = await window.api.saveSettings(partial);
  renderHotkeyHint(state.settings.hotkey);
  $('langSelect').value = state.settings.sttLanguage || 'en-US';
  $('settingsModal').classList.add('hidden');
  updateCounter($('answer').textContent);
  toast('Settings saved');
}

// ---------------- Event binding ----------------
function bindEvents() {
  $('toggleBtn').onclick = () => (state.listening ? stopListening() : startListening());
  $('settingsBtn').onclick = openSettings;
  $('closeSettings').onclick = () => $('settingsModal').classList.add('hidden');
  $('saveSettings').onclick = saveSettings;

  // Upload / clear the target job description (persisted together with settings on save)
  $('uploadJD').onclick = async () => {
    const r = await window.api.pickJD();
    if (!r) return;
    if (r.error) {
      toast('Failed to parse JD: ' + r.error, true);
      return;
    }
    $('setJD').value = r.text || '';
    toast(`Loaded JD: ${r.name} (${charCount(r.text)} chars). Click Save to keep it.`);
  };
  $('clearJD').onclick = () => {
    $('setJD').value = '';
  };

  $('generateBtn').onclick = triggerGenerate;
  $('cancelBtn').onclick = () => {
    window.api.cancelGenerate();
    endGenerate();
  };

  $('clearTranscript').onclick = () => {
    state.interim = { interviewer: null, interviewee: null };
    state.lastFinalSpeaker = null;
    state.history = [];
    if (state.listening) {
      $('transcript').innerHTML = '';
      addDaySeparator();
    } else {
      showEmptyState();
    }
  };

  $('uploadBtn').onclick = async () => {
    const res = await window.api.pickDocuments();
    if (res.errors && res.errors.length)
      toast('Some files failed to parse: ' + res.errors.join('; '), true);
    refreshDocs(res.docs);
  };
  $('clearDocsBtn').onclick = async () => refreshDocs(await window.api.clearDocuments());

  $('pasteBtn').onclick = () => $('pasteModal').classList.remove('hidden');
  $('closePaste').onclick = () => $('pasteModal').classList.add('hidden');
  $('savePaste').onclick = async () => {
    const name = $('pasteName').value.trim() || 'Pasted text';
    const text = $('pasteText').value;
    if (!text.trim()) {
      toast('Content is empty', true);
      return;
    }
    const docs = await window.api.addTextDocument({ name, text });
    $('pasteName').value = '';
    $('pasteText').value = '';
    $('pasteModal').classList.add('hidden');
    refreshDocs(docs);
    toast('Added to Knowledge Base');
  };

  // Transcription language switch: persisted; if currently listening, automatically reconnects to take effect right away
  $('langSelect').onchange = async (e) => {
    const lang = e.target.value;
    state.settings = await window.api.saveSettings({ sttLanguage: lang });
    $('setSttLang').value = lang;
    const label = e.target.selectedOptions[0].textContent;
    if (state.listening) {
      toast(`Transcript language → ${label}, reconnecting…`);
      await stopListening();
      await startListening();
    } else {
      toast(`Transcript language set to ${label}`);
    }
  };

  // Device changes
  navigator.mediaDevices.addEventListener('devicechange', listInputDevices);

  // The user manually edited the question box → no longer treated as an auto-recognized value
  $('questionBox').addEventListener('input', () => {
    state.autoQuestion = '';
  });

  // Auto-answer toggle
  $('autoAnswer').onchange = async (e) => {
    state.settings = await window.api.saveSettings({ autoAnswer: e.target.checked });
    toast(
      e.target.checked
        ? 'Auto-answer on — I’ll answer when the interviewer finishes a question'
        : 'Auto-answer off',
    );
  };

  // Global hotkey
  window.api.onHotkeyGenerate(() => triggerGenerate());

  // Generation event stream
  window.api.onAnswerStart(({ model, primary }) => {
    $('answer').textContent = '';
    updateCounter('');
    if (model && primary && model !== primary) {
      toast(`${primary} is busy — answered with ${model} instead`);
    }
  });
  // The recognized question: filled back into the "Current Question" box for viewing/editing
  window.api.onAnswerQuestion(({ reqId, question }) => {
    if (reqId !== state.reqId || !question) return;
    const box = $('questionBox');
    box.value = question; // A programmatic assignment doesn't fire an input event
    state.autoQuestion = question;
  });
  window.api.onAnswerChunk(({ reqId, delta }) => {
    if (reqId !== state.reqId) return;
    const ans = $('answer');
    ans.textContent += delta;
    updateCounter(ans.textContent);
    ans.scrollTop = ans.scrollHeight;
  });
  window.api.onAnswerDone(({ reqId }) => {
    if (reqId !== state.reqId) return;
    endGenerate();
  });
  window.api.onAnswerError(({ reqId, message }) => {
    if (reqId && reqId !== state.reqId) return;
    endGenerate();
    toast(message, true);
  });
}

// ---------------- Startup ----------------
async function init() {
  state.settings = await window.api.getSettings();
  renderHotkeyHint(state.settings.hotkey || 'Control+A');
  $('autoAnswer').checked = !!state.settings.autoAnswer;
  $('langSelect').value = state.settings.sttLanguage || 'en-US';
  showEmptyState();
  updateCounter('');
  bindEvents();
  await listInputDevices();
  await refreshDocs();
  if (!state.settings.deepgramApiKey || !state.settings.geminiApiKey) {
    setStatus('Configure API keys');
    openSettings();
  }
}

window.addEventListener('DOMContentLoaded', init);
