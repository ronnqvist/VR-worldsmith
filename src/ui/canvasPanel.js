/**
 * `ws-canvas-panel`: VR UI rendered onto a 2D canvas mapped to a single plane.
 *
 * Why: one mesh + one texture per panel is far cheaper on Quest 2 than dozens
 * of text/plane entities, needs no MSDF fonts, and lets us draw rich layouts
 * with the Canvas 2D API. Hit-testing uses the raycaster intersection's UV
 * coordinate, mapped back to canvas pixels.
 *
 * Usage (JS):
 *   const panel = el.components['ws-canvas-panel'];
 *   panel.configure({ width: 0.6, height: 0.3, pxPerMeter: 1600,
 *     render(ctx, api) { api.button('ok', 10, 10, 120, 50, 'OK'); ... },
 *     onPress(id) { ... } });
 *   panel.invalidate();   // re-render on state change
 *
 * `render` is called with a fresh button list each time; buttons declared via
 * api.button() become hit targets and get hover/press styling automatically.
 */
import AFRAME from 'aframe';

const THREE = AFRAME.THREE;

export const THEME = {
  bg: 'rgba(12,16,32,0.92)',
  bgSolid: '#0c1020',
  panelBorder: 'rgba(140,170,255,0.35)',
  btn: '#1d2747',
  btnHover: '#2c3b6b',
  btnActive: '#5b4bff',
  btnDanger: '#5a1f2e',
  btnOn: '#1f5a46',
  text: '#e8ecff',
  dim: '#8f9bc4',
  accent: '#8ab4ff',
  error: '#ff8a9a',
  ok: '#7de3b0',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
};

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Word-wraps text into lines that fit maxWidth; returns lines (truncated to maxLines with …). */
export function wrapText(ctx, text, maxWidth, maxLines = 99) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
      // Break very long words (API keys, ids) by characters.
      while (ctx.measureText(line).width > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/.{0,2}$/, '')}…`;
    return kept;
  }
  return lines;
}

AFRAME.registerComponent('ws-canvas-panel', {
  schema: {
    width: { default: 0.5 },
    height: { default: 0.3 },
    pxPerMeter: { default: 1400 },
    clickable: { default: true }
  },

  init() {
    this.spec = null;
    this.buttons = [];
    this.hoverId = null;
    this.pressId = null;
    this.raycasters = new Set();
    this.dirty = true;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false });
    this.mesh = null;
    this.buildMesh();

    this.onIntersected = (e) => { this.raycasters.add(e.detail.el); };
    this.onCleared = (e) => {
      this.raycasters.delete(e.detail.el);
      if (!this.raycasters.size && this.hoverId) { this.hoverId = null; this.dirty = true; }
    };
    this.onClick = (e) => this.handleClick(e);
    this.el.addEventListener('raycaster-intersected', this.onIntersected);
    this.el.addEventListener('raycaster-intersected-cleared', this.onCleared);
    this.el.addEventListener('click', this.onClick);
    this.setClickable(this.el.getAttribute('visible') !== false);
  },

  update(old) {
    if (old && (old.width !== this.data.width || old.height !== this.data.height || old.pxPerMeter !== this.data.pxPerMeter)) {
      this.buildMesh();
      this.dirty = true;
    }
  },

  buildMesh() {
    const { width, height, pxPerMeter } = this.data;
    this.canvas.width = Math.min(2048, Math.round(width * pxPerMeter));
    this.canvas.height = Math.min(2048, Math.round(height * pxPerMeter));
    // Canvas resize after upload needs a fresh texture object.
    if (this.mesh) {
      this.texture.dispose();
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.generateMipmaps = false;
      this.texture.minFilter = THREE.LinearFilter;
      this.material.map = this.texture;
      this.mesh.geometry.dispose();
    }
    const geo = new THREE.PlaneGeometry(width, height);
    if (!this.mesh) {
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.renderOrder = 10;
      this.el.setObject3D('mesh', this.mesh);
    } else {
      this.mesh.geometry = geo;
    }
  },

  /** Enables/disables ray hits; hidden panels must never swallow laser clicks. */
  setClickable(on) {
    if (on && this.data.clickable) this.el.classList.add('ws-clickable');
    else this.el.classList.remove('ws-clickable');
  },

  show(on) {
    this.el.setAttribute('visible', on);
    this.setClickable(on);
    if (on) this.dirty = true;
  },

  configure(spec) {
    this.spec = spec;
    if (spec.width && spec.height) {
      this.el.setAttribute('ws-canvas-panel', { width: spec.width, height: spec.height, pxPerMeter: spec.pxPerMeter || this.data.pxPerMeter });
    }
    this.dirty = true;
  },

  invalidate() { this.dirty = true; },

  tick() {
    if (!this.el.object3D.visible) return;
    // Hover tracking from any raycaster (laser or mouse) currently hitting us.
    let hover = null;
    for (const rc of this.raycasters) {
      const hit = rc.components.raycaster?.getIntersection(this.el);
      if (hit?.uv) { hover = this.hitTest(hit.uv); break; }
    }
    if (hover !== this.hoverId) { this.hoverId = hover; this.dirty = true; }
    if (this.dirty) this.redraw();
  },

  hitTest(uv) {
    const x = uv.x * this.canvas.width;
    const y = (1 - uv.y) * this.canvas.height;
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (!b.disabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
    }
    return null;
  },

  handleClick(e) {
    const uv = e.detail?.intersection?.uv;
    if (!uv || !this.spec?.onPress) return;
    const id = this.hitTest(uv);
    if (!id) return;
    this.pressId = id;
    this.dirty = true;
    setTimeout(() => { this.pressId = null; this.dirty = true; }, 140);
    try { this.spec.onPress(id, this.buttons.find((b) => b.id === id)); } catch (err) { console.error('[panel] onPress failed', err); }
  },

  redraw() {
    this.dirty = false;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.buttons = [];
    if (!this.spec?.render) return;
    const api = {
      w: canvas.width,
      h: canvas.height,
      theme: THEME,
      hoverId: this.hoverId,
      /**
       * Declares + draws a button. opts: {variant:'on'|'danger'|'accent', disabled, fontSize, align, sub}
       */
      button: (id, x, y, w, h, label, opts = {}) => {
        this.buttons.push({ id, x, y, w, h, disabled: !!opts.disabled, data: opts.data });
        const hovered = this.hoverId === id && !opts.disabled;
        const pressed = this.pressId === id;
        let fill = THEME.btn;
        if (opts.variant === 'on') fill = THEME.btnOn;
        if (opts.variant === 'danger') fill = THEME.btnDanger;
        if (opts.variant === 'accent') fill = THEME.btnActive;
        if (hovered) fill = opts.variant === 'accent' ? '#7565ff' : THEME.btnHover;
        if (pressed) fill = '#8a7dff';
        ctx.save();
        ctx.globalAlpha = opts.disabled ? 0.35 : 1;
        roundRect(ctx, x, y, w, h, Math.min(18, h / 3));
        ctx.fillStyle = fill;
        ctx.fill();
        if (hovered) { ctx.strokeStyle = THEME.accent; ctx.lineWidth = 3; ctx.stroke(); }
        ctx.fillStyle = THEME.text;
        const fs = opts.fontSize || Math.round(h * 0.38);
        ctx.font = `600 ${fs}px ${THEME.font}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = opts.align || 'center';
        const tx = opts.align === 'left' ? x + 18 : x + w / 2;
        if (opts.sub) {
          ctx.fillText(label, tx, y + h * 0.38, w - 24);
          ctx.font = `400 ${Math.round(fs * 0.62)}px ${THEME.font}`;
          ctx.fillStyle = THEME.dim;
          ctx.fillText(opts.sub, tx, y + h * 0.74, w - 24);
        } else {
          ctx.fillText(label, tx, y + h / 2 + 1, w - 24);
        }
        ctx.restore();
      },
      text: (str, x, y, opts = {}) => {
        ctx.save();
        ctx.fillStyle = opts.color || THEME.text;
        ctx.font = `${opts.weight || 400} ${opts.size || 28}px ${THEME.font}`;
        ctx.textAlign = opts.align || 'left';
        ctx.textBaseline = opts.baseline || 'top';
        if (opts.maxWidth && opts.wrap) {
          const lines = wrapText(ctx, str, opts.maxWidth, opts.maxLines || 99);
          const lh = opts.lineHeight || (opts.size || 28) * 1.25;
          lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
          ctx.restore();
          return lines.length * lh;
        }
        ctx.fillText(str, x, y, opts.maxWidth);
        ctx.restore();
        return (opts.size || 28) * 1.25;
      },
      background: (opts = {}) => {
        roundRect(ctx, 2, 2, canvas.width - 4, canvas.height - 4, opts.radius ?? 36);
        ctx.fillStyle = opts.fill || THEME.bg;
        ctx.fill();
        ctx.strokeStyle = opts.border || THEME.panelBorder;
        ctx.lineWidth = 3;
        ctx.stroke();
      },
      ctx
    };
    try {
      this.spec.render(ctx, api);
    } catch (err) {
      console.error('[panel] render failed', err);
    }
    this.texture.needsUpdate = true;
  },

  remove() {
    this.el.removeEventListener('raycaster-intersected', this.onIntersected);
    this.el.removeEventListener('raycaster-intersected-cleared', this.onCleared);
    this.el.removeEventListener('click', this.onClick);
    this.el.removeObject3D('mesh');
    this.texture.dispose();
    this.material.dispose();
  }
});

/**
 * `ws-lazy-follow`: eases an entity to a spot in front of the camera when it
 * drifts out of view — comfortable "soft HUD" for captions and toasts
 * (head-locked UI causes discomfort in VR).
 */
AFRAME.registerComponent('ws-lazy-follow', {
  schema: {
    distance: { default: 1.3 },
    yOffset: { default: -0.3 },
    angleThreshold: { default: 28 },
    speed: { default: 3 }
  },
  init() {
    this.camWorld = new THREE.Vector3();
    this.camDir = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.toObj = new THREE.Vector3();
    this.moving = true;
  },
  snap() { this.moving = true; this.computeTarget(); this.el.object3D.position.copy(this.target); this.face(); },
  computeTarget() {
    const cam = this.el.sceneEl.camera;
    if (!cam) return false;
    cam.getWorldPosition(this.camWorld);
    cam.getWorldDirection(this.camDir);
    this.camDir.y = 0;
    if (this.camDir.lengthSq() < 1e-6) this.camDir.set(0, 0, -1);
    this.camDir.normalize();
    this.target.copy(this.camWorld).addScaledVector(this.camDir, this.data.distance);
    this.target.y += this.data.yOffset;
    return true;
  },
  face() {
    const o = this.el.object3D;
    o.lookAt(this.camWorld.x, o.position.y, this.camWorld.z);
  },
  tick(t, dt) {
    if (!this.el.object3D.visible || !this.computeTarget()) return;
    const o = this.el.object3D;
    // Only start moving when the panel is far off-centre; then glide until settled.
    this.toObj.copy(o.position).sub(this.camWorld).setY(0).normalize();
    const angle = THREE.MathUtils.radToDeg(this.toObj.angleTo(this.camDir));
    if (angle > this.data.angleThreshold || o.position.distanceTo(this.target) > 1.2) this.moving = true;
    if (this.moving) {
      const k = 1 - Math.exp(-this.data.speed * (dt / 1000));
      o.position.lerp(this.target, k);
      if (o.position.distanceTo(this.target) < 0.01) this.moving = false;
    }
    this.face();
  }
});

const _cp = new THREE.Vector3();
const _cd = new THREE.Vector3();
/**
 * Places a world-space panel entity in front of the user's head, facing them,
 * optionally tilted back (for panels below eye level).
 */
export function placeInFront(el, { distance = 0.9, yOffset = -0.25, tilt = 0 } = {}) {
  const cam = el.sceneEl?.camera;
  if (!cam) return;
  cam.getWorldPosition(_cp);
  cam.getWorldDirection(_cd);
  _cd.y = 0;
  if (_cd.lengthSq() < 1e-6) _cd.set(0, 0, -1);
  _cd.normalize();
  const o = el.object3D;
  o.position.copy(_cp).addScaledVector(_cd, distance);
  o.position.y += yOffset;
  o.lookAt(_cp.x, o.position.y, _cp.z);
  if (tilt) o.rotateX(-tilt);
}
