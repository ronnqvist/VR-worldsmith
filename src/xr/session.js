/**
 * XR session management: capability detection, VR vs MR (passthrough) entry,
 * renderer configuration (transparent clear for MR, pixel-ratio cap) and an
 * fps sampler for diagnostics.
 *
 * EXTENSION POINT (v2): plane detection / anchors / hit-test for MR. Request
 * them as optional features here (sceneEl.setAttribute('webxr', {optionalFeatures:
 * ['plane-detection','anchors','hit-test', ...]})) and let A-Frame's
 * `ar-hit-test` / `anchored` / `real-world-meshing` components place generated
 * content on real surfaces. Not enabled in v1 to keep the session request
 * minimal and the Quest 2 permission prompt simple.
 */
import AFRAME from 'aframe';
import { bus } from '../core/bus.js';
import { createLogger } from '../core/log.js';

const log = createLogger('session');
const PIXEL_RATIO_CAP = 1.5;

/** fps sampler; emits `perf` on the bus about once per second. */
AFRAME.registerComponent('ws-perf', {
  init() {
    this.frames = 0;
    this.last = performance.now();
    this.fps = 0;
    this.lowStreak = 0;
    this.warned = false;
  },
  tick() {
    this.frames++;
    const now = performance.now();
    if (now - this.last < 1000) return;
    this.fps = Math.round((this.frames * 1000) / (now - this.last));
    this.frames = 0;
    this.last = now;
    const scene = this.el;
    const inXR = scene.is('vr-mode') || scene.is('ar-mode');
    const info = scene.renderer?.info?.render;
    const entities = scene.querySelector('#generated-world')?.querySelectorAll('*').length || 0;
    // Quest 2 runs at 72 Hz; sustained < 60 in XR means we are dropping frames.
    if (inXR && this.fps < 60) this.lowStreak++; else this.lowStreak = 0;
    if (this.lowStreak >= 5 && !this.warned) {
      this.warned = true;
      log.warn(`sustained low frame rate (${this.fps} fps) with ${entities} entities — consider simplifying the world`);
      bus.emit('perf:low', { fps: this.fps, entities });
    }
    bus.emit('perf', { fps: this.fps, inXR, calls: info?.calls ?? 0, triangles: info?.triangles ?? 0, entities });
  }
});

/**
 * @param {{sceneEl:HTMLElement, injector:{setMode:Function}, shell:{sky:HTMLElement, floor:HTMLElement}}} p
 */
export function initSession({ sceneEl, injector, shell }) {
  const caps = { vr: false, ar: false, xr: !!navigator.xr, secure: window.isSecureContext };
  let mode = 'none'; // 'none' | 'vr' | 'ar'

  const capPixelRatio = () => {
    const r = sceneEl.renderer;
    if (r) r.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
  };
  if (sceneEl.renderStarted) capPixelRatio(); else sceneEl.addEventListener('renderstart', capPixelRatio, { once: true });

  async function detect() {
    if (!navigator.xr) { bus.emit('xr:capabilities', { ...caps }); return caps; }
    try { caps.vr = await navigator.xr.isSessionSupported('immersive-vr'); } catch { caps.vr = false; }
    try { caps.ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch { caps.ar = false; }
    log.info('capabilities', caps);
    bus.emit('xr:capabilities', { ...caps });
    return caps;
  }

  function applyMode(next) {
    mode = next;
    const ar = next === 'ar';
    const r = sceneEl.renderer;
    if (r) {
      // MR: fully transparent clear so the passthrough camera image shows through.
      r.setClearColor(0x000000, ar ? 0 : 1);
      r.setClearAlpha(ar ? 0 : 1);
    }
    document.documentElement.classList.toggle('ws-mr', ar);
    shell.sky?.setAttribute('visible', !ar && shell.sky.dataset.wsHidden !== '1');
    shell.floor?.setAttribute('visible', !ar);
    injector.setMode(ar ? 'ar' : 'vr');
    bus.emit('xr:mode', { mode: next });
  }

  sceneEl.addEventListener('enter-vr', () => {
    const next = sceneEl.is('ar-mode') ? 'ar' : (sceneEl.xrSession ? 'vr' : 'none');
    log.info('entered', next);
    applyMode(next);
    bus.emit('xr:enter', { mode: next });
  });
  sceneEl.addEventListener('exit-vr', () => {
    log.info('exited immersive');
    applyMode('none');
    capPixelRatio(); // A-Frame resets pixel ratio to devicePixelRatio on exit
    bus.emit('xr:exit', {});
  });

  async function enter(target) {
    try {
      if (target === 'ar') {
        if (!caps.ar) throw new Error('Mixed reality is not supported on this device/browser.');
        await sceneEl.enterAR();
      } else {
        await sceneEl.enterVR();
      }
      return true;
    } catch (err) {
      log.warn('enter failed', err);
      const e = new Error(`Could not start ${target === 'ar' ? 'mixed reality' : 'VR'}: ${err.cause?.message || err.message}`);
      e.userMessage = e.message;
      throw e;
    }
  }

  function waitForSessionEnd(session, ms = 2000) {
    return new Promise((resolve) => {
      if (!session) { resolve(); return; }
      const t = setTimeout(resolve, ms);
      session.addEventListener('end', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  /**
   * Switch VR ⇄ MR. Inside a session we must end it first; requestSession then
   * needs transient user activation, which XR `select` events usually provide on
   * Quest. If the browser refuses, we report `xr:needs-gesture` and the 2D UI
   * shows a one-tap "Enter MR/VR" button.
   */
  async function switchTo(target) {
    if (mode === target) return;
    if (mode !== 'none') {
      const s = sceneEl.xrSession;
      sceneEl.exitVR();
      await waitForSessionEnd(s);
    }
    try {
      await enter(target);
    } catch (err) {
      bus.emit('xr:needs-gesture', { mode: target, message: err.userMessage });
    }
  }

  return {
    detect,
    enterVR: () => enter('vr'),
    enterMR: () => enter('ar'),
    exit: () => sceneEl.exitVR(),
    switchTo,
    getMode: () => mode,
    getCaps: () => ({ ...caps })
  };
}

/**
 * Browsers create the A-Frame/three.js AudioContext suspended until a user
 * gesture. Resume it on the first interaction (or when entering XR) so the
 * generated ambient `sound` components become audible.
 */
export function installAudioUnlock(sceneEl) {
  const resume = () => {
    try {
      const ctx = AFRAME.THREE.AudioContext.getContext();
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    } catch { /* no audio support */ }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, resume, { passive: true });
  sceneEl.addEventListener('enter-vr', resume);
}

/** Toggles A-Frame's stats overlay (diagnostics). */
export function setStats(sceneEl, on) {
  if (on) sceneEl.setAttribute('stats', '');
  else if (sceneEl.hasAttribute('stats')) sceneEl.removeAttribute('stats');
}

/**
 * A-Frame's scene setup unconditionally calls setAttribute('<name>', '') for a
 * few default components, clobbering the values written in index.html. We
 * re-apply ours: no built-in enter-VR button (we have our own), no 'f'
 * fullscreen shortcut while typing, no orientation prompt, and no inspector
 * (Ctrl+Alt+I would fetch it from a CDN).
 */
const SCENE_OVERRIDES = {
  'xr-mode-ui': 'enabled: false',
  'keyboard-shortcuts': 'enterVR: false; exitVR: true',
  'device-orientation-permission-ui': 'enabled: false'
};
function applySceneOverrides(sceneEl) {
  for (const [name, value] of Object.entries(SCENE_OVERRIDES)) sceneEl.setAttribute(name, value);
  if (sceneEl.hasAttribute('inspector')) sceneEl.removeAttribute('inspector');
  sceneEl.querySelectorAll('.a-enter-vr, .a-enter-ar, .a-orientation-modal').forEach((n) => n.remove());
}

/** Releases A-Frame's deferred initialisation (index.html sets AFRAME_ASYNC). */
export function startAFrame(sceneEl) {
  applySceneOverrides(sceneEl);
  AFRAME.emitReady();
  sceneEl.addEventListener('loaded', () => applySceneOverrides(sceneEl), { once: true });
}
