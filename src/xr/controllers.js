/**
 * Locomotion + controller bindings.
 *
 *  ws-locomotion (on #rig)
 *    • left thumbstick: smooth locomotion relative to head yaw
 *    • right thumbstick X: 45° snap turn pivoting around the head (not the rig origin)
 *    • desktop: WASD / arrow keys (ignored while typing), Q/E snap turn
 *    • drives the comfort vignette while moving
 *  ws-vignette (on a camera child): radial tunnel-vision overlay
 *  ws-controller-bindings (on each hand): maps buttons to app events
 *    left trigger hold = push-to-talk · Y = wrist panel · X = keyboard
 */
import AFRAME from 'aframe';
import { bus } from '../core/bus.js';
import { LIMITS } from '../core/config.js';

const THREE = AFRAME.THREE;

AFRAME.registerComponent('ws-locomotion', {
  schema: {
    leftHand: { type: 'selector', default: '#ws-left' },
    rightHand: { type: 'selector', default: '#ws-right' },
    speed: { default: 2.0 },
    snapDegrees: { default: 45 },
    deadzone: { default: 0.2 },
    vignette: { default: true }
  },

  init() {
    this.move = { x: 0, y: 0 };
    this.turnLatched = false;
    this.keys = new Set();
    this.suspendTurn = false; // set by ws-grab while push/pulling a grabbed object
    this.camPos = new THREE.Vector3();
    this.camPos2 = new THREE.Vector3();
    this.fwd = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.vignetteEl = this.el.sceneEl.querySelector('#ws-vignette');

    this.onLeftStick = (e) => { this.move.x = e.detail.x; this.move.y = e.detail.y; };
    this.onRightStick = (e) => this.handleTurnAxis(e.detail.x);
    this.onKeyDown = (e) => {
      if (isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'q' || k === 'e') { if (!e.repeat) this.snapTurn(k === 'q' ? 1 : -1); return; }
      this.keys.add(k);
    };
    this.onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this.onBlur = () => this.keys.clear();
  },

  play() {
    this.data.leftHand?.addEventListener('thumbstickmoved', this.onLeftStick);
    this.data.rightHand?.addEventListener('thumbstickmoved', this.onRightStick);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  },

  pause() {
    this.data.leftHand?.removeEventListener('thumbstickmoved', this.onLeftStick);
    this.data.rightHand?.removeEventListener('thumbstickmoved', this.onRightStick);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  },

  handleTurnAxis(x) {
    if (this.suspendTurn) return;
    if (!this.turnLatched && Math.abs(x) > 0.7) {
      this.turnLatched = true;
      this.snapTurn(x > 0 ? -1 : 1);
    } else if (this.turnLatched && Math.abs(x) < 0.3) {
      this.turnLatched = false;
    }
  },

  /** Rotates the rig around the camera's current world position. dir: +1 = left, -1 = right. */
  snapTurn(dir) {
    const cam = this.el.sceneEl.camera;
    const rig = this.el.object3D;
    if (!cam) return;
    cam.getWorldPosition(this.camPos);
    rig.rotation.y += THREE.MathUtils.degToRad(this.data.snapDegrees) * dir;
    rig.updateMatrixWorld(true);
    cam.getWorldPosition(this.camPos2);
    rig.position.x += this.camPos.x - this.camPos2.x;
    rig.position.z += this.camPos.z - this.camPos2.z;
  },

  tick(t, dt) {
    if (!dt) return;
    const sec = Math.min(dt, 100) / 1000;
    let mx = Math.abs(this.move.x) > this.data.deadzone ? this.move.x : 0;
    let my = Math.abs(this.move.y) > this.data.deadzone ? this.move.y : 0;
    // Desktop keys (only when not in an immersive session).
    if (this.keys.size) {
      if (this.keys.has('w') || this.keys.has('arrowup')) my -= 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) my += 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
      mx = Math.max(-1, Math.min(1, mx));
      my = Math.max(-1, Math.min(1, my));
    }
    const moving = mx !== 0 || my !== 0;
    if (moving) {
      const cam = this.el.sceneEl.camera;
      if (cam) {
        cam.getWorldDirection(this.fwd); // three.js camera looks down -Z; getWorldDirection returns that
        this.fwd.y = 0;
        if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
        this.fwd.normalize();
        this.right.crossVectors(this.fwd, this.up).normalize();
        const p = this.el.object3D.position;
        const step = this.data.speed * sec;
        p.addScaledVector(this.fwd, -my * step);
        p.addScaledVector(this.right, mx * step);
        p.x = Math.max(-LIMITS.maxCoord, Math.min(LIMITS.maxCoord, p.x));
        p.z = Math.max(-LIMITS.maxCoord, Math.min(LIMITS.maxCoord, p.z));
      }
    }
    const vig = this.vignetteEl?.components['ws-vignette'];
    if (vig) vig.setTarget(this.data.vignette && moving ? Math.min(1, Math.hypot(mx, my)) : 0);
  }
});

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** Radial vignette drawn on a small camera-locked plane; opacity eases with movement. */
AFRAME.registerComponent('ws-vignette', {
  schema: { strength: { default: 0.85 } },
  init() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 40, 128, 128, 128);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0)');
    grad.addColorStop(0.85, 'rgba(0,0,0,0.85)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    this.mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), this.mat);
    this.mesh.renderOrder = 999;
    this.mesh.visible = false;
    this.el.setObject3D('mesh', this.mesh);
    this.target = 0;
    this.value = 0;
  },
  setTarget(v) { this.target = v * this.data.strength; },
  tick(t, dt) {
    const k = 1 - Math.exp(-(dt || 16) / 120);
    this.value += (this.target - this.value) * k;
    this.mat.opacity = this.value;
    this.mesh.visible = this.value > 0.01;
  },
  remove() { this.el.removeObject3D('mesh'); this.mat.map.dispose(); this.mat.dispose(); }
});

/** Hand button → bus events. Works with meta-touch-controls and generic controllers. */
AFRAME.registerComponent('ws-controller-bindings', {
  schema: { hand: { default: 'left' } },
  init() {
    const left = this.data.hand === 'left';
    this.handlers = left ? {
      triggerdown: () => bus.emit('ptt:down', { source: 'controller' }),
      triggerup: () => bus.emit('ptt:up', { source: 'controller' }),
      ybuttondown: () => bus.emit('ui:toggle-wrist'),
      xbuttondown: () => bus.emit('ui:keyboard', { target: 'prompt' })
    } : {
      bbuttondown: () => bus.emit('ui:dismiss')
    };
    this.connected = (e) => bus.emit('xr:controller', { hand: this.data.hand, connected: true, name: e.detail?.name });
    this.disconnected = () => bus.emit('xr:controller', { hand: this.data.hand, connected: false });
  },
  play() {
    for (const [ev, fn] of Object.entries(this.handlers)) this.el.addEventListener(ev, fn);
    this.el.addEventListener('controllerconnected', this.connected);
    this.el.addEventListener('controllerdisconnected', this.disconnected);
  },
  pause() {
    for (const [ev, fn] of Object.entries(this.handlers)) this.el.removeEventListener(ev, fn);
    this.el.removeEventListener('controllerconnected', this.connected);
    this.el.removeEventListener('controllerdisconnected', this.disconnected);
  }
});
