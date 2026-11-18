/**
 * In-VR user interface (all canvas panels, see canvasPanel.js):
 *   • wrist panel on the left controller — Listen, Keyboard, Settings, History,
 *     Worlds, Undo, Export, Import, Reset, MR/VR (MR only when supported)
 *   • settings panel, history/saved-worlds panel (spawned in front of the user)
 *   • HUD: lazy-following caption (narration, transcript, errors) + toasts with
 *     an optional action button (e.g. "Undo" after deleting an object)
 *   • mic orb: floating, pulsing state indicator; tap it to talk
 *
 * The UI is a pure view over app state: it reads `app.state`, re-renders on
 * bus events and calls `app.*` actions. No world/LLM logic lives here.
 */
import AFRAME from 'aframe';
import { THEME, placeInFront } from './canvasPanel.js';
import { MODEL_PRESETS } from '../core/config.js';

const THREE = AFRAME.THREE;

const PHASE_COLORS = {
  idle: '#6c7cff',
  listening: '#ff5c7a',
  thinking: '#b07cff',
  speaking: '#3fd6a0',
  error: '#ff8a5c'
};
const PHASE_LABEL = { idle: 'Ready', listening: 'Listening…', thinking: 'Dreaming…', speaking: 'Speaking', error: 'Error' };

/** Floating mic orb with per-state colour and pulse. Click → app action via event. */
AFRAME.registerComponent('ws-mic-orb', {
  schema: { phase: { default: 'idle' } },
  init() {
    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.055, 1),
      new THREE.MeshStandardMaterial({ color: PHASE_COLORS.idle, emissive: PHASE_COLORS.idle, emissiveIntensity: 0.6, roughness: 0.3, flatShading: true })
    );
    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(0.075, 0.09, 40),
      new THREE.MeshBasicMaterial({ color: PHASE_COLORS.idle, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
    );
    const group = new THREE.Group();
    group.add(this.core, this.halo);
    this.el.setObject3D('mesh', group);
    this.el.classList.add('ws-clickable');
    this.camPos = new THREE.Vector3();
  },
  update() {
    const c = new THREE.Color(PHASE_COLORS[this.data.phase] || PHASE_COLORS.idle);
    this.core.material.color.copy(c);
    this.core.material.emissive.copy(c);
    this.halo.material.color.copy(c);
  },
  tick(t) {
    const s = t / 1000;
    let pulse = 1;
    let spin = 0.4;
    switch (this.data.phase) {
      case 'listening': pulse = 1 + 0.18 * Math.abs(Math.sin(s * 6)); spin = 1.5; break;
      case 'thinking': pulse = 1 + 0.08 * Math.sin(s * 3); spin = 3; break;
      case 'speaking': pulse = 1 + 0.12 * Math.abs(Math.sin(s * 9)); spin = 1; break;
      default: pulse = 1 + 0.04 * Math.sin(s * 1.5);
    }
    this.core.scale.setScalar(pulse);
    this.core.rotation.y = s * spin;
    this.halo.scale.setScalar(1 + (pulse - 1) * 2);
    this.halo.material.opacity = 0.25 + (pulse - 1) * 2;
    // Halo always faces the viewer.
    const cam = this.el.sceneEl.camera;
    if (cam) { cam.getWorldPosition(this.camPos); this.halo.lookAt(this.camPos); }
  },
  remove() { this.el.removeObject3D('mesh'); }
});

/**
 * @param {object} p
 * @param {HTMLElement} p.sceneEl
 * @param {object} p.app      app controller (state + actions), see main.js
 * @param {object} p.bus
 * @param {object} p.keyboard VR keyboard (keyboardVR.js)
 */
export function initVRUI({ sceneEl, app, bus, keyboard }) {
  const $ = (id) => sceneEl.querySelector(id);
  const wristEl = $('#ws-wrist');
  const settingsEl = $('#ws-settings-panel');
  const listEl = $('#ws-list-panel');
  const hudEl = $('#ws-hud');
  const orbEl = $('#ws-mic-orb');
  const P = (el) => el.components['ws-canvas-panel'];

  const hud = { caption: null, toast: null };
  let settingsStatus = '';
  let listTab = 'history';
  let listPage = 0;
  let confirmReset = false;

  /* ---------------- HUD (captions + toasts) ---------------- */

  function refreshHud() {
    const now = Date.now();
    if (hud.caption && hud.caption.until && hud.caption.until < now) hud.caption = null;
    if (hud.toast && hud.toast.until < now) hud.toast = null;
    const phase = app.state.phase;
    const show = !!(hud.caption || hud.toast || phase === 'listening' || phase === 'thinking');
    const panel = P(hudEl);
    if (!panel) return;
    if (show && !hudEl.getAttribute('visible')) {
      panel.show(true);
      hudEl.components['ws-lazy-follow']?.snap();
    } else if (!show && hudEl.getAttribute('visible')) {
      panel.show(false);
    }
    panel.invalidate();
  }
  setInterval(refreshHud, 500);

  P(hudEl)?.configure({
    width: 0.95, height: 0.26, pxPerMeter: 1300,
    render(ctx, api) {
      api.background({ radius: 30 });
      const phase = app.state.phase;
      let y = 22;
      const pad = 30;
      const hasToastAction = !!hud.toast?.actionLabel;
      const textW = api.w - pad * 2 - (hasToastAction ? 230 : 0);
      if (phase === 'listening' || phase === 'thinking') {
        api.text(PHASE_LABEL[phase], pad, y, { size: 30, weight: 700, color: PHASE_COLORS[phase] });
        y += 44;
      }
      if (hud.caption) {
        const color = hud.caption.kind === 'error' ? THEME.error : hud.caption.kind === 'transcript' ? THEME.dim : THEME.text;
        y += api.text(hud.caption.text, pad, y, { size: 34, color, maxWidth: textW, wrap: true, maxLines: hud.toast ? 2 : 4 });
      }
      if (hud.toast) {
        const color = hud.toast.kind === 'error' ? THEME.error : hud.toast.kind === 'ok' ? THEME.ok : THEME.accent;
        const ty = Math.max(y + 6, hasToastAction ? api.h - 110 : y);
        api.text(hud.toast.text, pad, ty + (hasToastAction ? 22 : 0), { size: 30, color, maxWidth: textW, wrap: true, maxLines: 2 });
        if (hasToastAction) {
          const secs = Math.max(0, Math.ceil((hud.toast.until - Date.now()) / 1000));
          api.button('toast-action', api.w - pad - 210, api.h - 110, 210, 84, `${hud.toast.actionLabel} (${secs})`, { variant: 'accent', fontSize: 30 });
        }
      }
    },
    onPress(id) {
      if (id === 'toast-action' && hud.toast?.onAction) {
        const fn = hud.toast.onAction;
        hud.toast = null;
        fn();
        refreshHud();
      }
    }
  });

  bus.on('caption', ({ text, kind = 'info', ms = 7000 }) => {
    hud.caption = text ? { text, kind, until: ms ? Date.now() + ms : 0 } : null;
    refreshHud();
  });
  bus.on('toast', ({ text, kind = 'info', ms = 3500, actionLabel, onAction }) => {
    hud.toast = { text, kind, until: Date.now() + ms, actionLabel, onAction };
    refreshHud();
  });

  /* ---------------- Wrist panel ---------------- */

  const WRIST_BUTTONS = () => {
    const st = app.state;
    const listening = st.phase === 'listening';
    const b = [
      ['listen', listening ? 'Stop' : 'Listen', listening ? 'on' : 'accent'],
      ['keyboard', 'Keyboard'],
      ['settings', 'Settings'],
      ['history', 'History'],
      ['worlds', 'Worlds'],
      ['undo', 'Undo', null, !st.canUndo],
      ['export', 'Export'],
      ['import', 'Import'],
      ['reset', confirmReset ? 'Sure?' : 'Reset', 'danger'],
      st.caps.ar ? ['mr', st.mode === 'ar' ? 'VR mode' : 'MR mode'] : ['exit', 'Exit XR']
    ];
    return b;
  };

  P(wristEl)?.configure({
    width: 0.3, height: 0.19, pxPerMeter: 2400,
    render(ctx, api) {
      api.background({ radius: 30 });
      const st = app.state;
      const pad = 22;
      ctx.fillStyle = PHASE_COLORS[st.phase] || THEME.accent;
      ctx.beginPath(); ctx.arc(pad + 12, 36, 11, 0, Math.PI * 2); ctx.fill();
      api.text(`${PHASE_LABEL[st.phase] || st.phase}`, pad + 32, 18, { size: 30, weight: 700 });
      const right = st.settings.diagnostics
        ? `${st.fps} fps · ${st.entities} ent · ${st.drawCalls} dc`
        : `${st.entities}/200 · ${st.hasKey ? 'key ✓' : 'no key'}`;
      api.text(right, api.w - pad, 22, { size: 24, color: st.hasKey ? THEME.dim : THEME.error, align: 'right' });
      const buttons = WRIST_BUTTONS();
      const cols = 5;
      const gap = 12;
      const top = 74;
      const bw = (api.w - pad * 2 - gap * (cols - 1)) / cols;
      const bh = (api.h - top - pad - gap) / 2;
      buttons.forEach(([id, label, variant, disabled], i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        api.button(id, pad + c * (bw + gap), top + r * (bh + gap), bw, bh, label, { variant, disabled, fontSize: 28 });
      });
    },
    onPress(id) {
      if (id !== 'reset') confirmReset = false;
      switch (id) {
        case 'listen': app.listenToggle(); break;
        case 'keyboard': app.openPromptInput({ forceKeyboard: true }); break;
        case 'settings': openSettings(); break;
        case 'history': openList('history'); break;
        case 'worlds': openList('worlds'); break;
        case 'undo': app.undo(); break;
        case 'export': app.exportData(); break;
        case 'import': app.requestImport(); break;
        case 'reset':
          if (confirmReset) { confirmReset = false; app.resetWorld(); }
          else { confirmReset = true; setTimeout(() => { confirmReset = false; P(wristEl)?.invalidate(); }, 3000); }
          break;
        case 'mr': app.toggleMR(); break;
        case 'exit': app.exitXR(); break;
        default: break;
      }
      P(wristEl)?.invalidate();
    }
  });

  function toggleWrist(force) {
    const panel = P(wristEl);
    if (!panel) return;
    const on = force ?? !wristEl.getAttribute('visible');
    panel.show(on);
  }

  /* ---------------- Settings panel ---------------- */

  function cycleModel(dir) {
    const ids = MODEL_PRESETS.map((m) => m.id);
    const cur = ids.indexOf(app.state.settings.model);
    const next = ids[(cur + dir + ids.length) % ids.length] || ids[0];
    app.updateSettings({ model: next });
  }

  P(settingsEl)?.configure({
    width: 0.95, height: 0.86, pxPerMeter: 1300,
    render(ctx, api) {
      api.background();
      const st = app.state;
      const s = st.settings;
      const pad = 34;
      const rowH = 84;
      const gap = 14;
      api.text('Settings', pad, 26, { size: 44, weight: 700, color: THEME.accent });
      api.button('close', api.w - pad - 150, 20, 150, 66, 'Close', { fontSize: 28 });
      let y = 112;
      const label = (t, sub) => {
        api.text(t, pad, y + 10, { size: 30, weight: 600 });
        if (sub) api.text(sub, pad, y + 48, { size: 22, color: THEME.dim, maxWidth: 520 });
      };
      const right = api.w - pad;

      label('OpenRouter API key', st.hasKey ? st.keyHint : 'Not set — required');
      api.button('key-edit', right - 380, y, 180, rowH, st.hasKey ? 'Change' : 'Enter', { fontSize: 28, variant: st.hasKey ? undefined : 'accent' });
      api.button('key-validate', right - 190, y, 190, rowH, 'Validate', { fontSize: 28, disabled: !st.hasKey });
      y += rowH + gap;

      const preset = MODEL_PRESETS.find((m) => m.id === s.model);
      label('Model', preset ? preset.label : `${s.model} (custom)`);
      api.button('model-prev', right - 420, y, 90, rowH, '◀');
      api.button('model-next', right - 320, y, 90, rowH, '▶');
      api.button('model-custom', right - 220, y, 220, rowH, 'Custom…', { fontSize: 28 });
      y += rowH + gap;

      const toggle = (id, title, on, sub) => {
        label(title, sub);
        api.button(id, right - 190, y, 190, rowH, on ? 'On' : 'Off', { variant: on ? 'on' : undefined, fontSize: 30 });
        y += rowH + gap;
      };
      toggle('tts', 'Spoken narration', !s.ttsMuted, st.ttsAvailable ? 'Uses the browser voice' : 'No voice here — captions only');
      toggle('vignette', 'Comfort vignette', s.vignette, 'Darkens edges while moving');
      toggle('diag', 'Diagnostics', s.diagnostics, 'FPS, draw calls, logging');

      label('Input', st.speechSupported ? (st.speechBroken ? 'Voice failed here; keyboard used' : 'Voice when available') : 'Voice unavailable — keyboard');
      ['auto', 'voice', 'keyboard'].forEach((m, i) => {
        api.button(`input-${m}`, right - 570 + i * 190, y, 180, rowH, m[0].toUpperCase() + m.slice(1), { variant: s.inputMode === m ? 'on' : undefined, fontSize: 26 });
      });
      y += rowH + gap;

      label('Request headers', `Title: ${s.title || '—'} · Referer: ${s.referer || '—'}`);
      api.button('hdr-title', right - 380, y, 180, rowH, 'Title…', { fontSize: 26 });
      api.button('hdr-referer', right - 190, y, 190, rowH, 'Referer…', { fontSize: 26 });
      y += rowH + gap + 6;

      if (settingsStatus) {
        api.text(settingsStatus, pad, y, { size: 26, color: /fail|reject|error|not/i.test(settingsStatus) ? THEME.error : THEME.ok, maxWidth: api.w - pad * 2, wrap: true, maxLines: 3 });
      }
    },
    async onPress(id) {
      const s = app.state.settings;
      switch (id) {
        case 'close': P(settingsEl).show(false); return;
        case 'key-edit':
          keyboard.open({
            title: 'OpenRouter API key (sk-or-v1-…)', value: '', masked: true, placeholder: 'Paste or type your key', submitLabel: 'Save',
            onSubmit: async (v) => { await app.setApiKey(v); settingsStatus = 'Key saved.'; P(settingsEl).invalidate(); }
          });
          return;
        case 'key-validate':
          settingsStatus = 'Validating…';
          P(settingsEl).invalidate();
          settingsStatus = await app.validateKey();
          break;
        case 'model-prev': cycleModel(-1); break;
        case 'model-next': cycleModel(1); break;
        case 'model-custom':
          keyboard.open({
            title: 'OpenRouter model id (e.g. vendor/model)', value: s.model, submitLabel: 'Save',
            onSubmit: (v) => app.updateSettings({ model: v.replace(/\s+/g, '') })
          });
          return;
        case 'tts': app.updateSettings({ ttsMuted: !s.ttsMuted }); break;
        case 'vignette': app.updateSettings({ vignette: !s.vignette }); break;
        case 'diag': app.updateSettings({ diagnostics: !s.diagnostics }); break;
        case 'input-auto': case 'input-voice': case 'input-keyboard':
          app.updateSettings({ inputMode: id.slice(6) });
          break;
        case 'hdr-title':
          keyboard.open({ title: 'X-Title header (blank = none)', value: s.title, allowEmpty: true, submitLabel: 'Save', onSubmit: (v) => app.updateSettings({ title: v }) });
          return;
        case 'hdr-referer':
          keyboard.open({ title: 'HTTP-Referer header (blank = none)', value: s.referer, allowEmpty: true, submitLabel: 'Save', onSubmit: (v) => app.updateSettings({ referer: v }) });
          return;
        default: break;
      }
      P(settingsEl).invalidate();
    }
  });

  function openSettings() {
    settingsStatus = '';
    P(listEl)?.show(false);
    placeInFront(settingsEl, { distance: 1.0, yOffset: -0.1, tilt: 0.1 });
    P(settingsEl).show(true);
  }

  /* ---------------- History / Worlds panel ---------------- */

  const PAGE = 7;
  P(listEl)?.configure({
    width: 0.95, height: 0.9, pxPerMeter: 1300,
    render(ctx, api) {
      api.background();
      const st = app.state;
      const pad = 34;
      api.button('tab-history', pad, 22, 220, 70, 'History', { variant: listTab === 'history' ? 'on' : undefined, fontSize: 30 });
      api.button('tab-worlds', pad + 236, 22, 220, 70, 'Worlds', { variant: listTab === 'worlds' ? 'on' : undefined, fontSize: 30 });
      api.button('close', api.w - pad - 150, 22, 150, 70, 'Close', { fontSize: 28 });
      let y = 116;
      const rowH = 98;
      let items = [];
      if (listTab === 'history') {
        items = [...st.history].reverse();
        api.text(items.length ? 'Tap a prompt to edit and send it again.' : 'No prompts yet.', pad, y, { size: 24, color: THEME.dim });
        y += 44;
      } else {
        items = st.worlds;
        api.button('save-world', pad, y, 360, 74, 'Save current…', { variant: 'accent', fontSize: 28, disabled: st.entities === 0 });
        api.text(items.length ? `${items.length} saved` : 'No saved worlds yet.', pad + 380, y + 22, { size: 24, color: THEME.dim });
        y += 92;
      }
      const pages = Math.max(1, Math.ceil(items.length / PAGE));
      listPage = Math.min(listPage, pages - 1);
      const slice = items.slice(listPage * PAGE, listPage * PAGE + PAGE);
      slice.forEach((item, i) => {
        const idx = listPage * PAGE + i;
        if (listTab === 'history') {
          const when = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          api.button(`h:${idx}`, pad, y, api.w - pad * 2, rowH - 12, truncate(item.prompt, 70), { align: 'left', fontSize: 28, sub: `${when}${item.narration ? ` · ${truncate(item.narration, 60)}` : ''}` });
        } else {
          const when = new Date(item.updatedAt).toLocaleDateString();
          api.button(`w:${idx}`, pad, y, api.w - pad * 2 - 130, rowH - 12, truncate(item.name, 40), { align: 'left', fontSize: 30, sub: `Load · saved ${when}` });
          api.button(`d:${idx}`, api.w - pad - 116, y, 116, rowH - 12, '✕', { variant: 'danger', fontSize: 32 });
        }
        y += rowH;
      });
      if (pages > 1) {
        const by = api.h - 96;
        api.button('prev', pad, by, 160, 70, '▲ Prev', { disabled: listPage === 0, fontSize: 26 });
        api.button('next', pad + 176, by, 160, 70, 'Next ▼', { disabled: listPage >= pages - 1, fontSize: 26 });
        api.text(`${listPage + 1} / ${pages}`, pad + 360, by + 22, { size: 26, color: THEME.dim });
      }
    },
    onPress(id) {
      const st = app.state;
      if (id === 'close') { P(listEl).show(false); return; }
      if (id === 'tab-history' || id === 'tab-worlds') { listTab = id.slice(4); listPage = 0; }
      else if (id === 'prev') listPage = Math.max(0, listPage - 1);
      else if (id === 'next') listPage++;
      else if (id === 'save-world') {
        keyboard.open({
          title: 'Name this world', value: `World ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
          submitLabel: 'Save', onSubmit: (name) => app.saveWorld(name)
        });
        return;
      } else if (id.startsWith('h:')) {
        const item = [...st.history].reverse()[Number(id.slice(2))];
        if (item) { P(listEl).show(false); app.openPromptInput({ forceKeyboard: true, value: item.prompt }); }
        return;
      } else if (id.startsWith('w:')) {
        const w = st.worlds[Number(id.slice(2))];
        if (w) { app.loadWorld(w.name); P(listEl).show(false); }
        return;
      } else if (id.startsWith('d:')) {
        const w = st.worlds[Number(id.slice(2))];
        if (w) app.deleteWorld(w.name);
      }
      P(listEl).invalidate();
    }
  });

  function openList(tab) {
    listTab = tab;
    listPage = 0;
    P(settingsEl)?.show(false);
    placeInFront(listEl, { distance: 1.0, yOffset: -0.1, tilt: 0.1 });
    P(listEl).show(true);
  }

  /* ---------------- Mic orb ---------------- */

  orbEl?.addEventListener('click', () => app.listenToggle());

  /* ---------------- Reactivity ---------------- */

  const invalidateAll = () => {
    P(wristEl)?.invalidate();
    P(settingsEl)?.invalidate();
    P(listEl)?.invalidate();
    P(hudEl)?.invalidate();
  };
  bus.on('state', ({ phase }) => {
    orbEl?.setAttribute('ws-mic-orb', 'phase', phase);
    refreshHud();
    invalidateAll();
  });
  bus.on('app:changed', invalidateAll);
  bus.on('perf', () => { if (app.state.settings.diagnostics) P(wristEl)?.invalidate(); });
  bus.on('ui:toggle-wrist', () => toggleWrist());
  bus.on('ui:dismiss', () => {
    if (keyboard.isOpen()) keyboard.cancel();
    else if (settingsEl.getAttribute('visible')) P(settingsEl).show(false);
    else if (listEl.getAttribute('visible')) P(listEl).show(false);
  });
  bus.on('xr:enter', () => { toggleWrist(true); hudEl.components['ws-lazy-follow']?.snap(); });

  return { openSettings, openList, toggleWrist };
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}
