/**
 * Worldsmith — composition root.
 *
 * Boot order (A-Frame runs with AFRAME_ASYNC, see index.html):
 *   1. import A-Frame + all custom components (registered synchronously)
 *   2. load persisted state, render the procedural ambient loop into
 *      <audio id="generated-ambient">
 *   3. AFRAME.emitReady() → scene initializes
 *   4. build injector / session / voice / UIs, restore the saved world
 *
 * The prompt pipeline lives here: input → OpenRouter → parse → sanitize →
 * inject → narrate. Modules talk through the `app` facade + the event bus.
 */
import './ui/style.css';
import './xr/controllers.js';
import './xr/grab.js';
import './world/dream.js';
import './ui/canvasPanel.js';
import { initSession, installAudioUnlock, setStats, startAFrame } from './xr/session.js';
import { initVRUI } from './ui/panelVR.js';
import { initDomUI } from './ui/dom.js';
import { createVRKeyboard } from './voice/keyboardVR.js';
import { createSpeechInput } from './voice/speech.js';
import { createCloudSpeech } from './voice/cloudSpeech.js';
import { createTTS } from './voice/tts.js';
import { createInjector } from './world/injector.js';
import { sanitizeMarkup } from './world/sanitize.js';
import { generateAmbientLoop } from './audio/ambient.js';
import { chatJSON, validateKey as validateOpenRouterKey, looksLikeKey } from './llm/openrouter.js';
import { buildSystemPrompt } from './llm/systemPrompt.js';
import { buildMessages, parseEnvelope } from './llm/envelope.js';
import { effortOptions, planReasoning, fetchCatalogue, setCatalogue, KNOWN_CAPS } from './llm/models.js';
import { createDefaultProvider } from './storage/localProvider.js';
import { createStore } from './storage/store.js';
import { buildExport, validateImport, combineImport, exportFilename, MAX_IMPORT_BYTES } from './storage/exportImport.js';
import { bus } from './core/bus.js';
import { createLogger, setDiagnostics } from './core/log.js';
import { installErrorBoundary, toUserMessage } from './core/errors.js';
import { APP_VERSION, CONTEXT_EXCHANGES, HISTORY_LIMIT, LIMITS } from './core/config.js';

const log = createLogger('app');

function setLoading(msg, isError = false) {
  const el = document.getElementById('ws-loading');
  const m = document.getElementById('ws-loading-msg');
  if (m) m.textContent = msg;
  el?.classList.toggle('ws-error', isError);
}

function hideLoading() {
  const el = document.getElementById('ws-loading');
  if (!el) return;
  el.classList.add('ws-done');
  setTimeout(() => el.remove(), 700);
}

function sceneReady(sceneEl) {
  return new Promise((resolve) => {
    if (sceneEl.hasLoaded) resolve();
    else sceneEl.addEventListener('loaded', () => resolve(), { once: true });
  });
}

const debounce = (fn, ms) => {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

async function boot() {
  installErrorBoundary((msg) => bus.emit('toast', { text: msg, kind: 'error', ms: 6000 }));
  log.info(`Worldsmith ${APP_VERSION}`);

  /* ---------- persisted state ---------- */
  const store = createStore(createDefaultProvider()); // swap provider here for a future backend
  const [settings, apiKeyStored, history, worlds, storedWorld] = await Promise.all([
    store.getSettings(), store.getApiKey(), store.getHistory(), store.listWorlds(), store.getWorld()
  ]);
  setDiagnostics(settings.diagnostics);
  let apiKey = apiKeyStored;

  /* ---------- ambient audio asset (before A-Frame loads <a-assets>) ---------- */
  setLoading('Tuning the ambience…');
  try {
    const url = await generateAmbientLoop();
    document.getElementById('generated-ambient').setAttribute('src', url);
  } catch (err) {
    log.warn('ambient generation failed', err);
  }

  /* ---------- start A-Frame ---------- */
  setLoading('Opening the void…');
  const sceneEl = document.querySelector('a-scene');
  startAFrame(sceneEl);
  await sceneReady(sceneEl);
  if (sceneEl.renderStarted) hideLoading(); else sceneEl.addEventListener('renderstart', hideLoading, { once: true });
  installAudioUnlock(sceneEl);

  const $ = (sel) => sceneEl.querySelector(sel);
  const shell = { sky: $('#ws-default-sky'), floor: $('#ws-floor'), ring: $('#ws-floor-ring'), hemi: $('#ws-env-hemi'), sun: $('#ws-env-sun') };
  const dream = () => $('#ws-dream')?.components['ws-dream'];
  const rig = $('#rig');

  /* ---------- app state ---------- */
  const keyHint = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : '');
  const state = {
    phase: 'idle',
    settings,
    history,
    worlds,
    hasKey: !!apiKey,
    keyHint: keyHint(apiKey),
    caps: { vr: false, ar: false },
    xrMode: 'none',
    mode: 'none',
    canUndo: false,
    entities: 0,
    fps: 0,
    drawCalls: 0,
    ttsAvailable: false,
    speechSupported: false,
    speechBroken: false
  };
  const changed = () => bus.emit('app:changed');
  const setPhase = (phase) => {
    if (state.phase === phase) return;
    state.phase = phase;
    dream()?.setActive(phase === 'thinking');
    bus.emit('state', { phase });
  };
  const caption = (text, kind = 'info', ms = 7000) => bus.emit('caption', { text, kind, ms });
  const toast = (text, kind = 'info', ms = 3500, actionLabel, onAction) => bus.emit('toast', { text, kind, ms, actionLabel, onAction });

  /* ---------- world ---------- */
  const persistWorld = debounce((snap) => {
    store.saveWorld(snap).catch((err) => toast(toUserMessage(err), 'error', 6000));
  }, 400);

  const injector = createInjector({
    container: $('#generated-world'),
    sceneEl,
    onChange(snap) {
      state.entities = injector.count();
      state.canUndo = injector.canUndo();
      persistWorld(snap);
      changed();
    },
    hooks: {
      onEnvironment({ hasSky, hasAmbient, hasDirectional, hasGround }) {
        // The shell's default sky/floor/lights step aside when the world brings its own.
        shell.sky.dataset.wsHidden = hasSky ? '1' : '0';
        shell.sky.setAttribute('visible', !hasSky && state.xrMode !== 'ar');
        const floorOn = !hasGround && !hasSky && state.xrMode !== 'ar';
        shell.floor.setAttribute('visible', floorOn);
        shell.ring.setAttribute('visible', floorOn);
        shell.hemi.setAttribute('visible', !hasAmbient);
        shell.sun.setAttribute('visible', !hasDirectional);
      }
    }
  });
  if (storedWorld?.markup) {
    try {
      injector.load(storedWorld, { pushToUndo: false, transition: false });
      log.info(`restored world with ${injector.count()} entities`);
    } catch (err) {
      log.error('could not restore stored world', err);
    }
  }

  /* ---------- XR session ---------- */
  const session = initSession({ sceneEl, injector, shell });
  bus.on('xr:capabilities', (caps) => { state.caps = caps; changed(); });
  bus.on('xr:mode', ({ mode }) => {
    state.xrMode = mode;
    state.mode = mode;
    // Re-apply environment visibility rules for the new mode.
    injector.setMode(mode === 'ar' ? 'ar' : 'vr');
    const hasSky = shell.sky.dataset.wsHidden === '1';
    shell.sky.setAttribute('visible', !hasSky && mode !== 'ar');
    changed();
  });
  bus.on('perf', (p) => { state.fps = p.fps; state.drawCalls = p.calls; });
  bus.on('perf:low', ({ fps, entities }) => toast(`Frame rate is low (${fps} fps, ${entities} entities). Try asking for a simpler world.`, 'error', 6000));

  /* ---------- voice ---------- */
  const keyboard = createVRKeyboard({ el: $('#ws-keyboard') });
  const tts = createTTS({ isMuted: () => state.settings.ttsMuted });
  const speech = createSpeechInput({
    getStatus: () => store.getSpeechStatus(),
    setStatus: (s) => store.setSpeechStatus(s),
    getMode: () => state.settings.inputMode
  });
  await speech.init();
  // Record + transcribe through OpenRouter: the voice path on browsers without
  // SpeechRecognition (Meta Quest Browser).
  const cloud = createCloudSpeech({
    getConfig: () => ({ apiKey, model: state.settings.sttModel, referer: state.settings.referer, title: state.settings.title })
  });
  let activeEngine = null;

  /** Chooses the speech engine for the current settings; null → keyboard. */
  function pickEngine() {
    const s = state.settings;
    if (s.inputMode === 'keyboard') return null;
    if (s.voiceEngine === 'browser') return speech.isSupported() ? speech : null;
    if (s.voiceEngine === 'openrouter') return cloud.isSupported() ? cloud : null;
    if (speech.isSupported() && !speech.isBroken()) return speech;
    return cloud.isSupported() ? cloud : null;
  }
  function refreshVoiceState() {
    const e = pickEngine();
    state.voiceEngineActive = e === speech ? 'browser' : e === cloud ? 'openrouter' : 'keyboard';
    state.speechSupported = speech.isSupported() || cloud.isSupported();
    state.speechBroken = speech.isBroken();
  }
  state.ttsAvailable = tts.available;
  refreshVoiceState();

  /* ---------- prompt pipeline ---------- */
  let busy = false;
  let inflight = null;

  async function submitPrompt(raw) {
    const prompt = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!prompt) return false;
    if (busy) { toast('Still dreaming up the last request…'); return false; }
    if (!apiKey) {
      caption('Add your OpenRouter API key in Settings first.', 'error', 8000);
      if (state.xrMode !== 'none') vrUI.openSettings();
      return false;
    }
    busy = true;
    tts.cancel();
    inflight = new AbortController();
    setPhase('thinking');
    caption(`“${prompt}”`, 'transcript', 0);
    const t0 = performance.now();
    try {
      const mode = state.xrMode === 'ar' ? 'ar' : 'vr';
      const messages = buildMessages({
        systemPrompt: buildSystemPrompt(mode),
        prompt,
        world: injector.serializeForContext(),
        recent: state.history.slice(-CONTEXT_EXCHANGES),
        mode
      });
      const s = state.settings;
      const res = await chatJSON({
        apiKey, model: s.model, messages, referer: s.referer, title: s.title,
        temperature: s.temperature, maxTokens: s.maxTokens, reasoningEffort: s.reasoningEffort, signal: inflight.signal
      });
      for (const n of res.notes || []) toast(n, 'info', 6000);
      const env = parseEnvelope(res.content);
      const report = injector.applyEnvelope(env);
      if (report.warnings.length) log.warn(`sanitizer/injector notes (${report.warnings.length})`, report.warnings.slice(0, 20));
      log.info(`${report.action}: +${report.added.length} ~${report.replaced.length} -${report.removed.length} in ${Math.round(performance.now() - t0)} ms (${res.model})`);
      state.history = await store.addHistory({ prompt, narration: env.narration, action: report.action });
      changed();
      const narration = env.narration || (report.action === 'create_world'
        ? 'Here is your new world.'
        : `Updated: ${report.added.length} added, ${report.replaced.length} changed, ${report.removed.length} removed.`);
      narrate(narration);
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') { caption('Request cancelled.', 'info', 3000); return false; }
      log.error('prompt failed', err);
      const msg = toUserMessage(err);
      caption(msg, 'error', 10000);
      setPhase('idle');
      return false;
    } finally {
      busy = false;
      inflight = null;
      if (state.phase === 'thinking') setPhase('idle');
    }
  }

  function narrate(text) {
    caption(text, 'info', 9000);
    setPhase('speaking');
    tts.speak(text).then(() => { if (state.phase === 'speaking') setPhase('idle'); });
  }

  /* ---------- input routing ---------- */
  function openPromptInput({ forceKeyboard = false, value = '' } = {}) {
    if (state.xrMode !== 'none') {
      keyboard.open({
        title: 'What should I create or change?',
        value,
        placeholder: 'e.g. add glowing crystals around the island',
        submitLabel: 'Send ➤',
        onSubmit: (text) => submitPrompt(text)
      });
      return;
    }
    if (!forceKeyboard && pickEngine()) { listenStart(); return; }
    bus.emit('dom:focus-prompt', { value: value || undefined });
  }

  function listenStart() {
    if (busy || cloud.isBusy()) { toast('Still working on the last request…'); return; }
    if (state.phase === 'listening') return;
    const engine = pickEngine();
    if (!engine) { openPromptInput({ forceKeyboard: true }); return; }
    activeEngine = engine;
    tts.cancel();
    const ok = engine.start({
      onInterim: (text) => { bus.emit('transcript', { text }); caption(text, 'transcript', 0); },
      onFinal: (text) => { bus.emit('transcript', { text, final: true }); submitPrompt(text); },
      onTranscribing: () => { setPhase('thinking'); caption('Transcribing…', 'transcript', 0); },
      onLevel: (rms) => bus.emit('mic:level', { rms }),
      onError: ({ fatal, message }) => {
        if (fatal && engine === speech && state.settings.voiceEngine === 'auto' && cloud.isSupported()) {
          // Browser recognizer is unusable here: fall through to OpenRouter transcription.
          refreshVoiceState();
          setPhase('idle');
          changed();
          toast('Browser speech recognition is unavailable; switched to OpenRouter transcription. Try again.', 'info', 6000);
          return;
        }
        toast(message, 'error', 6000);
        if (fatal) {
          refreshVoiceState();
          setPhase('idle');
          changed();
          openPromptInput({ forceKeyboard: true });
        }
      },
      onEnd: () => {
        activeEngine = null;
        if (state.phase === 'listening' || (state.phase === 'thinking' && !busy)) { setPhase('idle'); caption('', 'info', 1); }
      }
    });
    if (ok) {
      setPhase('listening');
      caption(engine === cloud ? 'Listening… release (or tap again) when done.' : 'Listening… release or tap again to send.', 'transcript', 0);
    }
  }
  function listenStop() { if (state.phase === 'listening') activeEngine?.stop(); }
  function listenToggle() { if (state.phase === 'listening') listenStop(); else listenStart(); }

  bus.on('ptt:down', () => listenStart());
  bus.on('ptt:up', () => listenStop());
  bus.on('ui:keyboard', () => openPromptInput({ forceKeyboard: true }));

  /* ---------- grab results ---------- */
  bus.on('world:transform', ({ id, position, rotation }) => injector.commitTransform(id, { position, rotation }));
  bus.on('world:delete', ({ id }) => {
    if (injector.removeEntity(id)) {
      toast(`Deleted “${id}”`, 'info', 3000, 'Undo', () => injector.undo());
    }
  });

  /* ---------- settings ---------- */
  function applySettings() {
    const s = state.settings;
    setDiagnostics(s.diagnostics);
    rig.setAttribute('ws-locomotion', { vignette: s.vignette, speed: s.smoothSpeed });
    setStats(sceneEl, s.showStats);
  }
  applySettings();

  async function updateSettings(partial) {
    state.settings = await store.saveSettings(partial);
    if (partial.model) ensureCaps(state.settings.model);
    applySettings();
    refreshVoiceState();
    changed();
    return state.settings;
  }

  async function setApiKey(key) {
    const k = String(key || '').trim();
    await store.setApiKey(k);
    apiKey = k;
    state.hasKey = !!k;
    state.keyHint = keyHint(k);
    refreshVoiceState();
    if (k && !looksLikeKey(k)) toast('That does not look like an OpenRouter key (sk-or-…). Saved anyway.', 'error', 5000);
    changed();
  }

  async function validateKey() {
    if (!apiKey) return 'Enter a key first.';
    try {
      const s = state.settings;
      await ensureCaps(s.model);
      const r = await validateOpenRouterKey({ apiKey, model: s.model, referer: s.referer, title: s.title, reasoningEffort: s.reasoningEffort });
      const credit = typeof r.key.limitRemaining === 'number' ? ` · remaining limit $${r.key.limitRemaining.toFixed(2)}` : '';
      const label = r.key.label ? ` (${r.key.label})` : '';
      return `Key valid ✓${label}${credit}. ${r.model.ok ? r.model.message : `Model check failed: ${r.model.message}`}`;
    } catch (err) {
      return toUserMessage(err);
    }
  }

  /* ---------- world management ---------- */
  function undo() {
    if (injector.undo()) toast('Undone.', 'ok', 1800);
    else toast('Nothing to undo.', 'info', 1800);
  }

  function resetWorld() {
    inflight?.abort();
    tts.cancel();
    cloud.abort();
    injector.reset();
    toast('World reset.', 'info', 5000, 'Undo', () => injector.undo());
  }

  async function saveWorld(name) {
    if (!injector.count()) { toast('The world is empty — nothing to save.', 'error'); return false; }
    try {
      state.worlds = await store.saveNamedWorld(name, injector.getSnapshot());
      toast(`Saved “${name}”.`, 'ok');
      changed();
      return true;
    } catch (err) {
      toast(toUserMessage(err), 'error', 6000);
      return false;
    }
  }

  function loadWorld(name) {
    const w = state.worlds.find((x) => x.name === name);
    if (!w) return;
    injector.load(w);
    toast(`Loaded “${name}”.`, 'ok', 2500, 'Undo', () => injector.undo());
  }

  async function deleteWorld(name) {
    state.worlds = await store.deleteNamedWorld(name);
    toast(`Deleted saved world “${name}”.`);
    changed();
  }

  async function clearHistory() {
    await store.clearHistory();
    state.history = [];
    changed();
  }

  /* ---------- export / import ---------- */
  function exportData() {
    const data = buildExport({
      settings: state.settings,
      savedWorlds: state.worlds,
      history: state.history,
      currentWorld: injector.getSnapshot()
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(state.xrMode !== 'none' ? 'Export downloaded — find it in the browser downloads.' : 'Export downloaded.', 'ok', 4000);
  }

  async function previewImport(file) {
    if (file.size > MAX_IMPORT_BYTES) return { ok: false, errors: ['File is too large (max 8 MB).'] };
    let obj;
    try { obj = JSON.parse(await file.text()); } catch { return { ok: false, errors: ['File is not valid JSON.'] }; }
    return validateImport(obj, { sanitize: (m) => sanitizeMarkup(m, { maxEntities: LIMITS.maxEntities }).markup });
  }

  async function commitImport(preview, mode) {
    const current = { settings: state.settings, savedWorlds: state.worlds, history: state.history, currentWorld: injector.getSnapshot() };
    const next = combineImport(current, preview.data, mode, HISTORY_LIMIT);
    state.settings = await store.saveSettings(next.settings);
    state.worlds = await store.setWorlds(next.savedWorlds);
    state.history = await store.setHistory(next.history);
    if (mode === 'replace' && next.currentWorld?.markup) injector.load(next.currentWorld);
    applySettings();
    changed();
    toast(`Imported (${mode}): ${preview.data.savedWorlds.length} world(s), ${preview.data.history.length} prompt(s).`, 'ok', 5000);
  }

  async function requestImport() {
    // File pickers cannot appear inside an immersive session: leave XR first.
    if (state.xrMode !== 'none') {
      await session.exit();
      toast('Import needs the 2D page — choose your file there.', 'info', 6000);
    }
    bus.emit('dom:request-import');
  }

  /* ---------- XR entry ---------- */
  async function enterXR(mode) {
    try {
      if (mode === 'ar') await session.enterMR(); else await session.enterVR();
    } catch (err) {
      toast(toUserMessage(err), 'error', 6000);
    }
  }
  const toggleMR = () => session.switchTo(state.xrMode === 'ar' ? 'vr' : 'ar');
  const exitXR = () => session.exit();

  bus.on('xr:enter', ({ mode }) => {
    caption(apiKey
      ? `${mode === 'ar' ? 'Mixed reality' : 'VR'} ready. Hold the left trigger to talk, press X for the keyboard, Y for the menu.`
      : 'Open the wrist menu (Y) → Settings to add your OpenRouter API key.', apiKey ? 'info' : 'error', 9000);
  });
  bus.on('xr:exit', () => { keyboard.close(); });

  /* ---------- app facade ---------- */
  /* ---------- model capabilities (reasoning levels differ per model) ---------- */
  const CAPS_TTL = 24 * 3600 * 1000;
  let capsLoading = null;
  const cachedCaps = await store.getModelCaps().catch(() => null);
  if (cachedCaps) setCatalogue(cachedCaps.caps);
  let capsAt = cachedCaps?.at || 0;
  let capsFailedAt = 0;
  /**
   * Loads the live catalogue at most once per TTL (and not again for a minute after
   * a failure), so unknown custom ids can't trigger repeated fetches.
   */
  function ensureCaps(modelId) {
    if (KNOWN_CAPS[modelId]) return Promise.resolve(); // verified presets need no download
    const fresh = Date.now() - capsAt < CAPS_TTL;
    if (fresh || Date.now() - capsFailedAt < 60_000) return Promise.resolve();
    if (!capsLoading) {
      capsLoading = fetchCatalogue()
        .then((caps) => { capsAt = Date.now(); return store.setModelCaps(caps); })
        .then(() => log.info('model catalogue cached'))
        .catch((err) => { capsFailedAt = Date.now(); log.warn('model catalogue unavailable', err); })
        .finally(() => { capsLoading = null; changed(); });
      changed();
    }
    return capsLoading;
  }
  /** Per-model reasoning options + what the current setting resolves to, for both UIs. */
  function getEffortInfo(modelId = state.settings.model) {
    const opts = effortOptions(modelId);
    const sent = planReasoning(modelId, state.settings.reasoningEffort, state.settings.maxTokens).effort;
    return { ...opts, setting: state.settings.reasoningEffort, sent, loading: !!capsLoading };
  }
  ensureCaps(state.settings.model);

  const app = {
    getEffortInfo,
    state,
    submitPrompt,
    listenStart,
    listenStop,
    listenToggle,
    openPromptInput,
    updateSettings,
    setApiKey,
    validateKey,
    undo,
    resetWorld,
    saveWorld,
    loadWorld,
    deleteWorld,
    clearHistory,
    exportData,
    previewImport,
    commitImport,
    requestImport,
    enterXR,
    toggleMR,
    exitXR
  };

  const vrUI = initVRUI({ sceneEl, app, bus, keyboard });
  initDomUI({ app, bus });

  state.entities = injector.count();
  state.canUndo = injector.canUndo();
  changed();
  await session.detect();

  // Console/debug handle (also used by automated tests).
  window.worldsmith = { app, injector, bus, sanitizeMarkup, version: APP_VERSION };
  log.info('ready');
}

boot().catch((err) => {
  console.error(err);
  setLoading(`Worldsmith failed to start: ${err?.message || err}. WebGL may be unavailable in this browser.`, true);
});
