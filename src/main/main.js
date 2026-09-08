'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  globalShortcut,
  session,
  desktopCapturer,
  systemPreferences,
  shell,
} = require('electron');

const settingsStore = require('./settings');
const store = require('./store');
const docs = require('./documents');
const llm = require('./llm');
const gemini = require('./gemini');
const openaiCompat = require('./openaiCompat');
const prompt = require('./prompt');
const { PROVIDERS } = require('./config');

// Resolve for the current Provider (the config.js registry): stream impl / Key / baseURL / model chain
function resolveProvider(s) {
  const id = s.provider && PROVIDERS[s.provider] ? s.provider : 'gemini';
  const p = PROVIDERS[id];
  const model = ((s[p.modelField] || '') + '').trim() || p.defaultModel;
  const models = [model, ...(p.fallbacks || [])].filter((m, i, a) => a.indexOf(m) === i);
  return {
    id,
    label: p.label,
    type: p.type,
    needsKey: !!p.keyField,
    apiKey: p.keyField ? s[p.keyField] || '' : '',
    baseURL: p.baseURLField ? s[p.baseURLField] || p.baseURL : p.baseURL,
    models,
    streamFn: p.type === 'gemini' ? gemini.generateAnswerStream : openaiCompat.generateAnswerStream,
  };
}

// Fix the app name so a dev run and the packaged .app share the same userData/settings.json
app.setName('interview-copilot');

let mainWindow = null;
let currentSettings = settingsStore.load();
let activeGen = null; // { id, controller }

function createWindow() {
  const smoke = !!process.env.INTERVIEW_SMOKE;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: !smoke,
    backgroundColor: '#0f1117',
    title: 'Real Time Interview Copilot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (smoke) {
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[smoke] window loaded OK');
      app.quit();
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[smoke] load failed', code, desc);
      process.exit(1);
    });
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer]', message);
    });
  }

  // Screenshot mode: inject a demo conversation, capture the window to
  // assets/screenshot.png, then quit (only used to generate README images).
  if (process.env.INTERVIEW_SCREENSHOT) {
    mainWindow.webContents.on('did-finish-load', () => {
      // Wait for init() to finish before injecting the demo content, so it isn't overwritten by showEmptyState.
      setTimeout(async () => {
        try {
          const fs = require('fs');
          await mainWindow.webContents.executeJavaScript(require('./_screenshotDemo').demoJs());
          await new Promise((r) => setTimeout(r, 350));
          const img = await mainWindow.webContents.capturePage();
          const out = path.join(__dirname, '..', '..', 'assets', 'screenshot.png');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, img.toPNG());
          console.log('[screenshot] wrote', out);
        } catch (e) {
          console.error('[screenshot] failed', e);
        }
        app.quit();
      }, 1000);
    });
  }

  // GIF mode: capture a frame per step in _gifDemo's timeline, then assemble
  // assets/demo.gif with ffmpeg (requires ffmpeg).
  if (process.env.INTERVIEW_GIF) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const fs = require('fs');
        const os = require('os');
        const { spawnSync } = require('child_process');
        try {
          const { steps } = require('./_gifDemo');
          const tmp = path.join(os.tmpdir(), 'ic-gif-frames');
          fs.rmSync(tmp, { recursive: true, force: true });
          fs.mkdirSync(tmp, { recursive: true });
          let n = 0;
          for (const s of steps()) {
            await mainWindow.webContents.executeJavaScript(s.js);
            for (let h = 0; h < (s.hold || 1); h++) {
              await new Promise((r) => setTimeout(r, 50));
              const img = await mainWindow.webContents.capturePage();
              fs.writeFileSync(
                path.join(tmp, `f_${String(n++).padStart(4, '0')}.png`),
                img.toPNG(),
              );
            }
          }
          const out = path.join(__dirname, '..', '..', 'assets', 'demo.gif');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const vf =
            'scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer';
          const r = spawnSync(
            'ffmpeg',
            [
              '-y',
              '-framerate',
              '9',
              '-i',
              path.join(tmp, 'f_%04d.png'),
              '-vf',
              vf,
              '-loop',
              '0',
              out,
            ],
            { encoding: 'utf8' },
          );
          if (r.status === 0) console.log('[gif] wrote', out, `(${n} frames)`);
          else
            console.error(
              '[gif] ffmpeg failed',
              (r.stderr || r.error || '').toString().slice(-600),
            );
        } catch (e) {
          console.error('[gif] failed', e);
        }
        app.quit();
      }, 1000);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Let the renderer process capture system audio (the interviewer) via getDisplayMedia.
function setupDisplayMediaLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      // macOS 13+: audio: 'loopback' captures system audio directly (needs
      // the "Screen Recording" permission).
      // A getSources failure is almost always a missing Screen Recording
      // grant — decline quietly and let the renderer guide the user to authorize it.
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources && sources.length) {
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          console.warn('No screen sources (grant Screen Recording permission for system audio).');
          callback({});
        }
      } catch (_e) {
        console.warn('System-audio capture unavailable — grant Screen Recording permission.');
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = currentSettings.hotkey || 'Control+A';
  try {
    const ok = globalShortcut.register(key, () => {
      if (mainWindow) mainWindow.webContents.send('hotkey-generate');
    });
    if (!ok) console.warn(`Failed to register hotkey ${key} (may already be in use)`);
    return ok;
  } catch (e) {
    console.error('Error registering hotkey:', e);
    return false;
  }
}

// ---------- IPC ----------

ipcMain.handle('get-settings', () => currentSettings);

ipcMain.handle('save-settings', (_e, partial) => {
  currentSettings = settingsStore.save(partial || {});
  registerHotkey();
  return currentSettings;
});

ipcMain.handle('list-documents', () => store.summary());

ipcMain.handle('remove-document', (_e, id) => store.remove(id));

ipcMain.handle('clear-documents', () => store.clear());

ipcMain.handle('pick-documents', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select interview materials (resume / JD / notes, etc.)',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Documents',
        extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'json', 'csv', 'log'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return { canceled: true, docs: store.summary() };

  const errors = [];
  for (const filePath of result.filePaths) {
    try {
      const text = await docs.parseFile(filePath);
      store.add(path.basename(filePath), text);
    } catch (e) {
      errors.push(`${path.basename(filePath)}: ${e.message}`);
    }
  }
  return { canceled: false, docs: store.summary(), errors };
});

// Add manually pasted document text
ipcMain.handle('add-text-document', (_e, { name, text }) => {
  store.add(name || 'Manual input', text || '');
  return store.summary();
});

// Pick and parse a JD file, returning plain text (persistence is handled by settings)
ipcMain.handle('pick-jd', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select job description file',
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  try {
    const text = await docs.parseFile(result.filePaths[0]);
    return { name: path.basename(result.filePaths[0]), text };
  } catch (e) {
    return { name: '', text: '', error: e.message };
  }
});

// Cancel an in-progress generation
ipcMain.on('cancel-generate', () => {
  if (activeGen) {
    try {
      activeGen.controller.abort();
    } catch (_e) {
      /* ignore */
    }
    activeGen = null;
  }
});

// Generate an answer (streaming)
ipcMain.on('generate-answer', async (_e, { reqId, question, transcript }) => {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, { reqId, ...payload });
    }
  };

  const q = (question || '').trim();
  const tr = (transcript || '').trim();
  if (!q && !tr) {
    send('answer-error', {
      message: 'No dialogue detected. Start listening first, or type your question manually.',
    });
    return;
  }

  const prov = resolveProvider(currentSettings);
  if (prov.needsKey && !prov.apiKey) {
    send('answer-error', {
      message: `${prov.label} API Key is not configured. Please set it in "Settings".`,
    });
    return;
  }

  // Cancel the previous one
  if (activeGen) {
    try {
      activeGen.controller.abort();
    } catch (_e) {
      /* ignore */
    }
  }
  const controller = new AbortController();
  activeGen = { id: reqId, controller };

  const context = store.buildContext(currentSettings.maxContextChars || 60000);
  const { systemInstruction, userText } = prompt.buildPrompt({
    question: q,
    transcript: tr,
    context,
    answerLanguage: currentSettings.answerLanguage || 'auto',
    maxChars: currentSettings.maxChars || 500,
    profile: currentSettings.interviewProfile || '',
    jobDescription: currentSettings.jobDescription || '',
  });

  // Output token ceiling.
  // - OpenAI-compatible providers (including DeepSeek/Ollama) may be
  //   "reasoning models": max_tokens must also cover the hidden thinking
  //   chain, and too small a budget leaves the answer empty, so this is
  //   generous and answer length is controlled by the prompt instead (the
  //   thinking chain is never shown to the user).
  // - Gemini already has thinking disabled (thinkingBudget=0), so this can be
  //   tightened against the character cap as a length backstop.
  const maxChars = currentSettings.maxChars || 500;
  const lang = currentSettings.answerLanguage || 'auto';
  const perChar = lang === 'en' ? 0.5 : 1.1;
  const maxOutputTokens =
    prov.type === 'openai'
      ? 4096
      : Math.min(4096, Math.max(160, Math.ceil(maxChars * perChar * 1.15)));
  const extractTokens = prov.type === 'openai' ? 1024 : 80;

  const common = {
    streamFn: prov.streamFn,
    apiKey: prov.apiKey,
    baseURL: prov.baseURL,
    models: prov.models,
    thinkingBudget: 0,
    signal: controller.signal,
  };

  // Extraction mode (question box left empty): run a lightweight call in
  // parallel that fills the recognized question back into the "Current
  // Question" box. It only looks at the most recent turns (the last 6
  // lines), runs alongside answer generation, and doesn't block it.
  if (!q && tr) {
    const recentTr = tr.split('\n').slice(-6).join('\n');
    llm
      .generateWithFallback({
        ...common,
        systemInstruction: prompt.EXTRACTION_SYSTEM,
        userText: prompt.buildExtractionUser(recentTr),
        maxOutputTokens: extractTokens,
        onChunk: () => {},
      })
      .then((r) => send('answer-question', { question: (r.text || '').trim() }))
      .catch(() => {});
  }

  try {
    await llm.generateWithFallback({
      ...common,
      systemInstruction,
      userText,
      maxOutputTokens,
      onStart: (model) => send('answer-start', { question: q, model, primary: prov.models[0] }),
      onChunk: (delta) => send('answer-chunk', { delta }),
    });
    send('answer-done', {});
  } catch (e) {
    if (e.name === 'AbortError') {
      send('answer-done', { aborted: true });
    } else {
      send('answer-error', { message: e.message });
    }
  } finally {
    if (activeGen && activeGen.id === reqId) activeGen = null;
  }
});

// Screen Recording permission (macOS) — needed to capture system audio (loopback)
ipcMain.handle('get-screen-permission', () => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
});

ipcMain.handle('open-screen-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  }
  return true;
});

// Microphone permission (macOS)
ipcMain.handle('ensure-mic-permission', async () => {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (_e) {
    return false;
  }
});

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  // Give the dock our icon during a dev run (npm start) too; the packaged build uses the bundle's own icns.
  if (process.platform === 'darwin' && app.dock) {
    try {
      const devIcon = path.join(__dirname, '..', '..', 'build', 'icon.png');
      if (require('fs').existsSync(devIcon)) app.dock.setIcon(devIcon);
    } catch (_e) {
      /* ignore */
    }
  }
  setupDisplayMediaLoopback();
  createWindow();
  registerHotkey();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
