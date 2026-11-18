/**
 * 2D DOM interface for desktop / phone / Quest-browser-2D use. Mirrors every
 * in-VR feature: prompt box + mic, settings (key, model, headers, toggles),
 * history, saved worlds, undo/reset/export/import, VR/MR entry, captions,
 * toasts, diagnostics. A pure view over `app` (see main.js) — no A-Frame here.
 */
import { MODEL_PRESETS, STT_MODEL_PRESETS } from '../core/config.js';
import { onLog, getLogEntries } from '../core/log.js';

const PHASE_LABEL = { idle: 'Ready', listening: 'Listening…', thinking: 'Dreaming up your world…', speaking: 'Speaking', error: 'Error' };

export function initDomUI({ app, bus }) {
  const $ = (id) => document.getElementById(id);
  const ui = $('ws-ui');
  ui.hidden = false;

  /* ---------------- top bar / XR buttons ---------------- */
  const phaseDot = $('ws-phase-dot');
  const phaseLabel = $('ws-phase-label');
  const enterVR = $('ws-enter-vr');
  const enterMR = $('ws-enter-mr');
  enterVR.addEventListener('click', () => app.enterXR('vr'));
  enterMR.addEventListener('click', () => app.enterXR('ar'));
  bus.on('xr:capabilities', (caps) => {
    enterVR.hidden = !caps.vr;
    enterMR.hidden = !caps.ar;
    if (!caps.secure) toast('WebXR needs HTTPS. VR buttons are hidden on insecure origins.', 'error', 8000);
  });

  /* ---------------- drawer + tabs ---------------- */
  const drawer = $('ws-drawer');
  const drawerToggle = $('ws-drawer-toggle');
  drawerToggle.addEventListener('click', () => {
    drawer.hidden = !drawer.hidden;
    drawerToggle.setAttribute('aria-expanded', String(!drawer.hidden));
  });
  function selectTab(name) {
    for (const t of drawer.querySelectorAll('.ws-tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
    for (const p of drawer.querySelectorAll('.ws-panel')) p.hidden = p.dataset.panel !== name;
  }
  for (const t of drawer.querySelectorAll('.ws-tab')) t.addEventListener('click', () => selectTab(t.dataset.tab));

  /* ---------------- prompt ---------------- */
  const form = $('ws-prompt-form');
  const promptEl = $('ws-prompt');
  const sendBtn = $('ws-send');
  const mic = $('ws-mic');
  const autogrow = () => { promptEl.style.height = 'auto'; promptEl.style.height = `${Math.min(160, promptEl.scrollHeight)}px`; };
  promptEl.addEventListener('input', autogrow);
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = promptEl.value.trim();
    if (!text) { promptEl.focus(); return; }
    app.submitPrompt(text).then((ok) => { if (ok) { promptEl.value = ''; autogrow(); } });
  });

  // Mic: tap toggles, press-and-hold = push-to-talk.
  let pressAt = 0;
  let wasListening = false;
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pressAt = Date.now();
    wasListening = app.state.phase === 'listening';
    if (!wasListening) app.listenStart({ source: 'dom' });
  });
  mic.addEventListener('pointerup', () => {
    const held = Date.now() - pressAt > 450;
    if (wasListening || held) app.listenStop();
  });
  mic.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); app.listenToggle(); } });

  bus.on('transcript', ({ text }) => { if (app.state.xrMode === 'none') { promptEl.value = text; autogrow(); } });
  bus.on('dom:focus-prompt', ({ value } = {}) => {
    if (value !== undefined) { promptEl.value = value; autogrow(); }
    promptEl.focus();
  });

  /* ---------------- caption + toasts ---------------- */
  const caption = $('ws-caption');
  let captionTimer = 0;
  bus.on('caption', ({ text, kind = 'info', ms = 7000 }) => {
    clearTimeout(captionTimer);
    if (!text) { caption.hidden = true; return; }
    caption.textContent = text;
    caption.className = `ws-caption ws-${kind}`;
    caption.hidden = false;
    if (ms) captionTimer = setTimeout(() => { caption.hidden = true; }, ms);
  });

  const toasts = $('ws-toasts');
  function toast(text, kind = 'info', ms = 3500, actionLabel, onAction) {
    const el = document.createElement('div');
    el.className = `ws-toast ws-${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const span = document.createElement('span');
    span.textContent = text;
    el.append(span);
    if (actionLabel && onAction) {
      const b = document.createElement('button');
      b.className = 'ws-btn ws-small ws-accent';
      b.textContent = actionLabel;
      b.addEventListener('click', () => { el.remove(); onAction(); });
      el.append(b);
    }
    toasts.append(el);
    while (toasts.children.length > 4) toasts.firstChild.remove();
    setTimeout(() => el.remove(), ms);
  }
  bus.on('toast', ({ text, kind, ms, actionLabel, onAction }) => toast(text, kind, ms, actionLabel, onAction));

  /* ---------------- settings ---------------- */
  const keyInput = $('ws-key');
  const keyStatus = $('ws-key-status');
  const setKeyStatus = (msg, kind = '') => { keyStatus.textContent = msg; keyStatus.className = `ws-status ${kind ? `ws-${kind}` : ''}`; };
  $('ws-key-show').addEventListener('click', () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; });
  $('ws-key-save').addEventListener('click', async () => {
    await app.setApiKey(keyInput.value);
    keyInput.value = '';
    setKeyStatus(app.state.hasKey ? `Saved (${app.state.keyHint}).` : 'Key removed.', 'ok');
  });
  $('ws-key-validate').addEventListener('click', async () => {
    if (keyInput.value.trim()) await app.setApiKey(keyInput.value);
    keyInput.value = '';
    setKeyStatus('Validating…');
    const msg = await app.validateKey();
    setKeyStatus(msg, /✓|answered|valid/i.test(msg) && !/fail|reject|not/i.test(msg) ? 'ok' : 'error');
  });
  $('ws-key-clear').addEventListener('click', async () => { await app.setApiKey(''); setKeyStatus('Key removed from this browser.', 'ok'); });

  const modelSelect = $('ws-model-select');
  for (const m of MODEL_PRESETS) modelSelect.append(new Option(m.label, m.id));
  modelSelect.append(new Option('Custom (type below)…', '__custom'));
  const modelInput = $('ws-model');
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value === '__custom') { modelInput.focus(); return; }
    app.updateSettings({ model: modelSelect.value });
  });
  modelInput.addEventListener('change', () => { if (modelInput.value.trim()) app.updateSettings({ model: modelInput.value.trim() }); });

  const sttSelect = $('ws-stt-select');
  for (const m of STT_MODEL_PRESETS) sttSelect.append(new Option(m.label, m.id));
  sttSelect.append(new Option('Custom (type below)…', '__custom'));
  const sttInput = $('ws-stt-model');
  sttSelect.addEventListener('change', () => {
    if (sttSelect.value === '__custom') { sttInput.focus(); return; }
    app.updateSettings({ sttModel: sttSelect.value });
  });
  sttInput.addEventListener('change', () => { if (sttInput.value.trim()) app.updateSettings({ sttModel: sttInput.value.trim() }); });

  const bindText = (id, key, parse = (v) => v) => $(id).addEventListener('change', (e) => app.updateSettings({ [key]: parse(e.target.value) }));
  bindText('ws-title', 'title');
  bindText('ws-referer', 'referer');
  bindText('ws-temperature', 'temperature', Number);
  bindText('ws-maxtokens', 'maxTokens', Number);
  bindText('ws-input-mode', 'inputMode');
  bindText('ws-voice-engine', 'voiceEngine');
  $('ws-tts').addEventListener('change', (e) => app.updateSettings({ ttsMuted: !e.target.checked }));
  $('ws-vignette').addEventListener('change', (e) => app.updateSettings({ vignette: e.target.checked }));
  $('ws-diagnostics').addEventListener('change', (e) => app.updateSettings({ diagnostics: e.target.checked }));
  $('ws-stats').addEventListener('change', (e) => app.updateSettings({ showStats: e.target.checked }));

  function renderSettings() {
    const s = app.state.settings;
    keyInput.placeholder = app.state.hasKey ? `Saved: ${app.state.keyHint} (enter a new one to replace)` : 'sk-or-v1-…';
    const preset = MODEL_PRESETS.some((m) => m.id === s.model);
    modelSelect.value = preset ? s.model : '__custom';
    if (document.activeElement !== modelInput) modelInput.value = s.model;
    const setVal = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    setVal('ws-title', s.title);
    setVal('ws-referer', s.referer);
    setVal('ws-temperature', s.temperature);
    setVal('ws-maxtokens', s.maxTokens);
    $('ws-input-mode').value = s.inputMode;
    $('ws-voice-engine').value = s.voiceEngine;
    sttSelect.value = STT_MODEL_PRESETS.some((m) => m.id === s.sttModel) ? s.sttModel : '__custom';
    if (document.activeElement !== sttInput) sttInput.value = s.sttModel;
    $('ws-voice-status').textContent = {
      browser: 'Active: browser speech recognition.',
      openrouter: 'Active: recording + OpenRouter transcription (small cost per clip).',
      keyboard: 'Active: keyboard (no voice engine available).'
    }[app.state.voiceEngineActive] || '';
    $('ws-tts').checked = !s.ttsMuted;
    $('ws-vignette').checked = s.vignette;
    $('ws-diagnostics').checked = s.diagnostics;
    $('ws-stats').checked = s.showStats;
    $('ws-diag-box').hidden = !s.diagnostics;
  }

  /* ---------------- history ---------------- */
  const historyEl = $('ws-history');
  function renderHistory() {
    historyEl.replaceChildren();
    for (const h of [...app.state.history].reverse()) {
      const li = document.createElement('li');
      const grow = document.createElement('div');
      grow.className = 'ws-grow';
      grow.title = 'Put back into the prompt box';
      const p = document.createElement('span');
      p.textContent = h.prompt;
      const sm = document.createElement('small');
      sm.textContent = `${new Date(h.at).toLocaleString()}${h.narration ? ` — ${h.narration}` : ''}`;
      grow.append(p, sm);
      grow.addEventListener('click', () => { promptEl.value = h.prompt; autogrow(); promptEl.focus(); });
      li.append(grow);
      historyEl.append(li);
    }
    if (!app.state.history.length) {
      const li = document.createElement('li');
      li.textContent = 'No prompts yet.';
      historyEl.append(li);
    }
  }
  $('ws-history-clear').addEventListener('click', () => app.clearHistory());

  /* ---------------- worlds ---------------- */
  const worldsEl = $('ws-worlds');
  const saveName = $('ws-save-name');
  $('ws-save-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = saveName.value.trim() || `World ${new Date().toLocaleString()}`;
    if (await app.saveWorld(name)) saveName.value = '';
  });
  function renderWorlds() {
    worldsEl.replaceChildren();
    for (const w of app.state.worlds) {
      const li = document.createElement('li');
      const grow = document.createElement('div');
      grow.className = 'ws-grow';
      const n = document.createElement('span');
      n.textContent = w.name;
      const sm = document.createElement('small');
      sm.textContent = `Saved ${new Date(w.updatedAt).toLocaleString()}`;
      grow.append(n, sm);
      const load = document.createElement('button');
      load.className = 'ws-btn ws-small ws-accent';
      load.textContent = 'Load';
      load.addEventListener('click', () => app.loadWorld(w.name));
      const del = document.createElement('button');
      del.className = 'ws-btn ws-small ws-danger';
      del.textContent = '✕';
      del.title = 'Delete';
      del.addEventListener('click', () => { if (confirm(`Delete saved world "${w.name}"?`)) app.deleteWorld(w.name); });
      li.append(grow, load, del);
      worldsEl.append(li);
    }
    if (!app.state.worlds.length) {
      const li = document.createElement('li');
      li.textContent = 'No saved worlds yet.';
      worldsEl.append(li);
    }
  }

  /* ---------------- tools ---------------- */
  const undoBtn = $('ws-undo');
  undoBtn.addEventListener('click', () => app.undo());
  $('ws-reset').addEventListener('click', () => { if (confirm('Reset the world? (You can undo this.)')) app.resetWorld(); });
  $('ws-export').addEventListener('click', () => app.exportData());
  const fileInput = $('ws-import-file');
  $('ws-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await runImport(file);
  });

  const dialog = $('ws-import-dialog');
  async function runImport(file) {
    const preview = await app.previewImport(file);
    if (!preview.ok) { toast(`Import failed: ${preview.errors.join(' ')}`, 'error', 8000); return; }
    const d = preview.data;
    $('ws-import-summary').textContent =
      `${d.savedWorlds.length} saved world(s), ${d.history.length} history item(s)${d.currentWorld ? ', a current world' : ''}.` +
      `${preview.warnings.length ? ` Notes: ${preview.warnings.join(' ')}` : ''} Merge keeps your data and adds these; Replace overwrites settings, saved worlds, history and the current world (your API key is always kept).`;
    dialog.returnValue = 'cancel';
    dialog.showModal();
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'merge' || dialog.returnValue === 'replace') app.commitImport(preview, dialog.returnValue);
    }, { once: true });
  }

  /* ---------------- one-tap gesture overlay ---------------- */
  const gesture = $('ws-gesture');
  const gestureBtn = $('ws-gesture-btn');
  let gestureAction = null;
  gestureBtn.addEventListener('click', () => { gesture.hidden = true; const fn = gestureAction; gestureAction = null; fn?.(); });
  function askGesture(message, label, fn) {
    $('ws-gesture-msg').textContent = message;
    gestureBtn.textContent = label;
    gestureAction = fn;
    gesture.hidden = false;
  }
  bus.on('xr:needs-gesture', ({ mode, message }) => {
    askGesture(message || 'The browser needs a tap to switch modes.', mode === 'ar' ? 'Enter mixed reality' : 'Enter VR', () => app.enterXR(mode));
  });
  bus.on('dom:request-import', () => askGesture('Choose a .worldsmith.json file to import.', 'Choose file…', () => fileInput.click()));

  /* ---------------- diagnostics ---------------- */
  const logEl = $('ws-log');
  const perfLine = $('ws-perf-line');
  const fmtLog = (e) => `${new Date(e.t).toLocaleTimeString()} ${e.level.toUpperCase()} [${e.scope}] ${e.msg}`;
  logEl.textContent = getLogEntries().map(fmtLog).join('\n');
  onLog((e) => {
    if (!app.state.settings.diagnostics) return;
    logEl.textContent += `\n${fmtLog(e)}`;
    if (logEl.textContent.length > 40000) logEl.textContent = logEl.textContent.slice(-30000);
    logEl.scrollTop = logEl.scrollHeight;
  });
  bus.on('perf', (p) => {
    if (app.state.settings.diagnostics) perfLine.textContent = `${p.fps} fps · ${p.entities} entities · ${p.calls} draw calls · ${p.triangles} tris`;
  });

  /* ---------------- reactivity ---------------- */
  function renderState() {
    const st = app.state;
    phaseDot.dataset.phase = st.phase;
    phaseLabel.textContent = PHASE_LABEL[st.phase] || st.phase;
    mic.classList.toggle('ws-listening', st.phase === 'listening');
    form.classList.toggle('ws-busy', st.phase === 'thinking');
    sendBtn.disabled = st.phase === 'thinking';
    sendBtn.textContent = st.phase === 'thinking' ? '…' : 'Send';
    undoBtn.disabled = !st.canUndo;
  }
  bus.on('state', renderState);
  bus.on('app:changed', () => { renderState(); renderSettings(); renderHistory(); renderWorlds(); });
  renderState();
  renderSettings();
  renderHistory();
  renderWorlds();

  // First-run nudge: no key yet → open settings.
  if (!app.state.hasKey) {
    drawer.hidden = false;
    drawerToggle.setAttribute('aria-expanded', 'true');
    selectTab('settings');
    setKeyStatus('Add your OpenRouter API key to start building worlds.');
  }

  return { toast, selectTab };
}
