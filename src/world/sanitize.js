/**
 * Whitelist sanitizer for LLM-generated A-Frame markup.
 *
 * Threat model: the LLM output is untrusted text (prompt injection, model
 * mistakes, a malicious proxy, or a tampered import file). It must never
 * be able to run script, load network resources, reach app internals, or
 * blow the Quest 2 performance budget.
 *
 * Strategy (defence in depth):
 *   0. Size + raw pattern pre-scan (cheap hard rejects).
 *   1. Normalise self-closing custom tags, parse with DOMParser into an
 *      INERT document (no browsing context → no scripts, no image loads,
 *      no custom-element upgrades).
 *   2. Global forbidden scan over EVERY element/attribute, including those we
 *      would drop anyway — the spec requires rejecting the whole response if
 *      anything forbidden appears, not just silently stripping it.
 *   3. Rebuild a brand-new tree in a second inert document, copying ONLY
 *      validated tags/attributes/component properties. Input nodes are never
 *      cloned or reused, so anything we didn't explicitly copy is gone.
 *   4. Clamp numbers to budgets, cap entity/light/sound counts, normalise ids.
 *
 * Two failure tiers:
 *   - SanitizeError (hard reject): forbidden constructs → caller keeps world.
 *   - warnings (soft drop): unknown-but-harmless tags/attrs/props are removed.
 *
 * This module is pure: it only needs DOMParser + document.implementation, and
 * never touches the live page DOM.
 */
import { LIMITS, RESERVED_IDS, RESERVED_ID_PREFIX, AMBIENT_ASSET_ID } from '../core/config.js';

export class SanitizeError extends Error {
  constructor(reason) {
    super(`Generated markup rejected: ${reason}`);
    this.name = 'SanitizeError';
    this.reason = reason;
    this.userMessage = `The generated world was rejected for safety (${reason}). Your current world is unchanged.`;
  }
}

/* ------------------------------------------------------------------------ */
/* Tables                                                                    */
/* ------------------------------------------------------------------------ */

/** Tags whose mere presence rejects the whole response. */
const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'img', 'image', 'picture', 'source', 'video', 'audio', 'track', 'svg', 'math', 'meta',
  'base', 'form', 'input', 'button', 'textarea', 'select', 'template', 'slot', 'portal',
  'noscript', 'canvas', 'a', 'area', 'map', 'xml', 'foreignobject',
  'a-assets', 'a-asset-item', 'a-gltf-model', 'a-obj-model', 'a-image', 'a-video',
  'a-videosphere', 'a-sound', 'a-link', 'a-curvedimage', 'a-mixin', 'a-cubemap', 'a-camera',
  'a-cursor'
]);

/** Attribute names whose presence rejects the response (regardless of value). */
const FORBIDDEN_ATTRS = new Set([
  'href', 'xlink:href', 'srcset', 'srcdoc', 'action', 'formaction', 'background',
  'poster', 'data', 'codebase', 'gltf-model', 'obj-model', 'mtl', 'src', 'mixin',
  'link', 'raycaster', 'cursor', 'laser-controls', 'tracked-controls', 'hand-controls',
  'look-controls', 'wasd-controls', 'camera', 'inspector', 'embedded', 'screenshot',
  'gltf', 'obj', 'collada-model', 'environment', 'is', 'contenteditable'
]);

/** Values that are never acceptable anywhere (including text). */
const DANGEROUS_VALUE = /(?:javascript|vbscript|livescript)\s*:|\bdata:[a-z]+\/[a-z0-9.+-]+[;,]|<\s*\/?\s*script|expression\s*\(|@import/i;
/** URL-ish values: forbidden in every property except free text. */
const URLISH_VALUE = /(?:^|[\s('"=])(?:[a-z][a-z0-9+.-]*:\/\/|\/\/[^\s/]|blob:|file:|ftp:|wss?:|https?:|www\.)/i;

const MESH_GEOMETRIES = {
  box: ['width', 'height', 'depth', 'segmentsWidth', 'segmentsHeight', 'segmentsDepth'],
  sphere: ['radius', 'segmentsWidth', 'segmentsHeight', 'phiStart', 'phiLength', 'thetaStart', 'thetaLength'],
  cylinder: ['radius', 'height', 'segmentsRadial', 'segmentsHeight', 'openEnded', 'thetaStart', 'thetaLength'],
  cone: ['radiusBottom', 'radiusTop', 'height', 'segmentsRadial', 'segmentsHeight', 'openEnded', 'thetaStart', 'thetaLength'],
  plane: ['width', 'height', 'segmentsWidth', 'segmentsHeight'],
  circle: ['radius', 'segments', 'thetaStart', 'thetaLength'],
  ring: ['radiusInner', 'radiusOuter', 'segmentsTheta', 'segmentsPhi', 'thetaStart', 'thetaLength'],
  torus: ['radius', 'radiusTubular', 'segmentsRadial', 'segmentsTubular', 'arc'],
  icosahedron: ['radius', 'detail'],
  octahedron: ['radius', 'detail'],
  tetrahedron: ['radius', 'detail'],
  dodecahedron: ['radius', 'detail']
};

/**
 * Quest-friendly default tessellation, injected when the LLM omits it.
 * A-Frame's own defaults (sphere 36×18, cylinder 36×18) are ~4× heavier.
 */
const PERF_DEFAULTS = {
  sphere: { segmentsWidth: 16, segmentsHeight: 12 },
  cylinder: { segmentsRadial: 16, segmentsHeight: 1 },
  cone: { segmentsRadial: 16, segmentsHeight: 1 },
  circle: { segments: 24 },
  ring: { segmentsTheta: 24, segmentsPhi: 1 },
  torus: { segmentsRadial: 10, segmentsTubular: 24 },
  sky: { segmentsWidth: 32, segmentsHeight: 16 }
};

/** tag → geometry primitive for mesh primitives. a-entity/a-light/a-text have none. */
const TAG_GEOMETRY = {
  'a-box': 'box', 'a-sphere': 'sphere', 'a-cylinder': 'cylinder', 'a-cone': 'cone',
  'a-plane': 'plane', 'a-circle': 'circle', 'a-ring': 'ring', 'a-torus': 'torus',
  'a-icosahedron': 'icosahedron', 'a-octahedron': 'octahedron', 'a-tetrahedron': 'tetrahedron',
  'a-dodecahedron': 'dodecahedron', 'a-sky': 'sphere'
};

export const ALLOWED_TAGS = new Set(['a-entity', 'a-light', 'a-text', ...Object.keys(TAG_GEOMETRY)]);

const MATERIAL_PROPS = [
  'color', 'opacity', 'transparent', 'side', 'shader', 'metalness', 'roughness', 'emissive',
  'emissiveIntensity', 'wireframe', 'flatShading', 'fog', 'visible', 'alphaTest',
  'depthWrite', 'blending', 'dithering', 'vertexColorsEnabled', 'toneMapped'
];
const LIGHT_PROPS = ['type', 'color', 'groundColor', 'intensity', 'distance', 'decay', 'angle', 'penumbra', 'target'];
const TEXT_PROPS = [
  'value', 'align', 'anchor', 'baseline', 'color', 'width', 'height', 'wrapCount', 'opacity',
  'side', 'letterSpacing', 'lineHeight', 'whiteSpace', 'xOffset', 'yOffset', 'zOffset',
  'transparent', 'tabSize', 'alphaTest'
];
const SOUND_PROPS = [
  'src', 'autoplay', 'loop', 'volume', 'positional', 'refDistance', 'rolloffFactor',
  'maxDistance', 'distanceModel', 'on', 'stopOn', 'pauseOn', 'loopStart', 'loopEnd'
];
const ANIMATION_PROPS = [
  'property', 'from', 'to', 'dur', 'delay', 'dir', 'easing', 'loop', 'autoplay', 'enabled',
  'round', 'type', 'elasticity', 'startEvents', 'pauseEvents', 'resumeEvents', 'isRawProperty'
];
const FOG_PROPS = ['type', 'color', 'near', 'far', 'density'];

/** Animatable properties. geometry.* is excluded: it rebuilds buffers every frame. */
const ANIMATABLE = {
  position: 'vec3pos', rotation: 'vec3rot', scale: 'vec3scale', visible: 'bool',
  'material.color': 'color', 'material.opacity': 'unit', 'material.emissive': 'color',
  'material.emissiveIntensity': 'intensity', 'light.intensity': 'intensity', 'light.color': 'color',
  'text.color': 'color', 'text.opacity': 'unit',
  'object3D.position.x': 'coord', 'object3D.position.y': 'coord', 'object3D.position.z': 'coord',
  'object3D.rotation.x': 'angle', 'object3D.rotation.y': 'angle', 'object3D.rotation.z': 'angle'
};

/** Events the LLM may wire to animations/sound (emitted by A-Frame cursor or our grab). */
const SAFE_EVENTS = new Set([
  'click', 'mouseenter', 'mouseleave', 'mousedown', 'mouseup', 'grab-start', 'grab-end',
  'animationcomplete', 'loaded'
]);

const EASING_RE = /^(linear|ease(In|Out|InOut|OutIn)(Quad|Cubic|Quart|Quint|Sine|Expo|Circ|Back|Elastic|Bounce))$/;
const NAMED_COLOR_RE = /^[a-z]{3,24}$/i;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_COLOR_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[-\d.%\s,/]+\)$/i;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (n) => String(Math.round(n * 10000) / 10000);
const toCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const toKebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function parseNum(raw) {
  const n = Number.parseFloat(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

/** Parses A-Frame's `a: b; c: d` component syntax into an ordered list of [camelKey, value]. */
export function parseStyle(str) {
  const out = [];
  for (const chunk of String(str).split(';')) {
    const i = chunk.indexOf(':');
    if (i === -1) { if (chunk.trim()) out.push([null, chunk.trim()]); continue; }
    const key = chunk.slice(0, i).trim();
    const value = chunk.slice(i + 1).trim();
    if (key) out.push([toCamel(key), value]);
  }
  return out;
}

function stringifyStyle(pairs) {
  return pairs.map(([k, v]) => `${k}: ${v}`).join('; ');
}

/* ------------------------------------------------------------------------ */
/* Value validators. Return sanitized string, or null to drop (with warning). */
/* Throw SanitizeError to reject everything.                                  */
/* ------------------------------------------------------------------------ */

const V = {
  num: (lo, hi) => (raw) => { const n = parseNum(raw); return n === null ? null : fmt(clamp(n, lo, hi)); },
  int: (lo, hi) => (raw) => { const n = parseNum(raw); return n === null ? null : String(clamp(Math.round(n), lo, hi)); },
  bool: () => (raw) => {
    const s = String(raw).trim().toLowerCase();
    if (s === '' || s === 'true') return 'true';
    if (s === 'false') return 'false';
    return null;
  },
  oneOf: (list) => (raw) => { const s = String(raw).trim(); return list.includes(s) ? s : null; },
  color: () => (raw) => {
    const s = String(raw).trim();
    if (HEX_COLOR_RE.test(s) || NAMED_COLOR_RE.test(s) || FUNC_COLOR_RE.test(s)) return s;
    return null;
  },
  vec3: (lo, hi, { nonZero = false, scalar = false } = {}) => (raw) => {
    const parts = String(raw).trim().split(/[\s,]+/).filter(Boolean).map(parseNum);
    if (scalar && parts.length === 1 && parts[0] !== null) parts.push(parts[0], parts[0]); // scale="2" → "2 2 2"
    if (parts.length !== 3 || parts.some((p) => p === null)) return null;
    return parts.map((p) => {
      let v = clamp(p, lo, hi);
      if (nonZero && Math.abs(v) < 0.001) v = 0.001; // zero scale breaks matrix inverse
      return fmt(v);
    }).join(' ');
  },
  text: (max) => (raw) => {
    // Strip control chars (keep \n via literal "\n" which A-Frame text understands).
    // eslint-disable-next-line no-control-regex
    const s = String(raw).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').slice(0, max);
    return s;
  },
  selector: () => (raw) => {
    const s = String(raw).trim();
    return /^#[A-Za-z][\w-]{0,63}$/.test(s) ? s : null;
  },
  events: () => (raw) => {
    const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    const ok = list.filter((e) => SAFE_EVENTS.has(e));
    return ok.length ? ok.join(', ') : null;
  }
};

const size = V.num(0, LIMITS.maxSize);
const angle = V.num(-720, 720);
const intensity = V.num(0, LIMITS.maxLightIntensity);
const unit = V.num(0, 1);

const GEOMETRY_VALIDATORS = {
  width: size, height: size, depth: size, radius: size, radiusTop: size, radiusBottom: size,
  radiusInner: size, radiusOuter: size, radiusTubular: size,
  segmentsWidth: V.int(3, LIMITS.maxSegments), segmentsHeight: V.int(1, LIMITS.maxSegmentsSmall),
  segmentsDepth: V.int(1, 8), segmentsRadial: V.int(3, LIMITS.maxSegments),
  segmentsTubular: V.int(3, LIMITS.maxSegments), segments: V.int(3, LIMITS.maxSegments),
  segmentsTheta: V.int(3, LIMITS.maxSegments), segmentsPhi: V.int(1, 8),
  detail: V.int(0, LIMITS.maxDetail), openEnded: V.bool(),
  thetaStart: angle, thetaLength: angle, phiStart: angle, phiLength: angle, arc: angle
};

const MATERIAL_VALIDATORS = {
  color: V.color(), opacity: unit, transparent: V.bool(), side: V.oneOf(['front', 'back', 'double']),
  shader: V.oneOf(['standard', 'flat']), metalness: unit, roughness: unit, emissive: V.color(),
  emissiveIntensity: intensity, wireframe: V.bool(), flatShading: V.bool(), fog: V.bool(),
  visible: V.bool(), alphaTest: unit, depthWrite: V.bool(),
  blending: V.oneOf(['normal', 'additive']), dithering: V.bool(), vertexColorsEnabled: V.bool(),
  toneMapped: V.bool()
};

const LIGHT_VALIDATORS = {
  type: V.oneOf(['ambient', 'directional', 'hemisphere', 'point', 'spot']),
  color: V.color(), groundColor: V.color(), intensity, distance: V.num(0, 200),
  decay: V.num(0, 5), angle: V.num(0, 90), penumbra: unit, target: V.selector()
};

const TEXT_VALIDATORS = {
  value: V.text(LIMITS.maxTextLength), align: V.oneOf(['left', 'right', 'center']),
  anchor: V.oneOf(['left', 'right', 'center', 'align']), baseline: V.oneOf(['top', 'center', 'bottom']),
  color: V.color(), width: V.num(0, 50), height: V.num(0, 50), wrapCount: V.num(1, 200),
  opacity: unit, side: V.oneOf(['front', 'back', 'double']), letterSpacing: V.num(-20, 50),
  lineHeight: V.num(0, 200), whiteSpace: V.oneOf(['normal', 'pre', 'nowrap']),
  xOffset: V.num(-50, 50), yOffset: V.num(-50, 50), zOffset: V.num(-1, 1),
  transparent: V.bool(), tabSize: V.int(1, 8), alphaTest: unit
};

const SOUND_VALIDATORS = {
  autoplay: V.bool(), loop: V.bool(), volume: V.num(0, 1), positional: V.bool(),
  refDistance: V.num(0, 100), rolloffFactor: V.num(0, 10), maxDistance: V.num(0, 1000),
  distanceModel: V.oneOf(['linear', 'inverse', 'exponential']), on: V.events(), stopOn: V.events(),
  pauseOn: V.events(), loopStart: V.num(0, 60), loopEnd: V.num(0, 60)
};

const FOG_VALIDATORS = {
  type: V.oneOf(['linear', 'exponential']), color: V.color(), near: V.num(0, 1000),
  far: V.num(0, 2000), density: V.num(0, 1)
};

const ANIM_VALUE_VALIDATORS = {
  vec3pos: V.vec3(-LIMITS.maxCoord, LIMITS.maxCoord),
  vec3rot: V.vec3(-36000, 36000),
  vec3scale: V.vec3(-LIMITS.maxScale, LIMITS.maxScale, { nonZero: true, scalar: true }),
  bool: V.bool(), color: V.color(), unit, intensity,
  coord: V.num(-LIMITS.maxCoord, LIMITS.maxCoord), angle: V.num(-36000, 36000)
};

/* ------------------------------------------------------------------------ */
/* Sanitizer                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Turns `<a-box ... />` into `<a-box ...></a-box>`. The HTML parser ignores the
 * self-closing slash on non-void elements, so without this every following
 * sibling would silently become a CHILD of the box (inheriting its transform).
 * The attribute sub-pattern understands quoted values, so `/>` inside quotes
 * is not mistaken for the tag end.
 */
export function normalizeSelfClosing(markup) {
  return markup.replace(
    /<(a-[a-z0-9-]+)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/>/gi,
    '<$1$2></$1>'
  );
}

/** Heuristic used by the injector to hide sky/ground in MR passthrough. */
export function isSkyOrGround(el) {
  const tag = el.localName;
  if (tag === 'a-sky') return true;
  // Raw DOM attribute strings: on live A-Frame entities getAttribute() returns
  // parsed component objects, which this string-based heuristic can't use.
  const attr = (n) => {
    const v = Element.prototype.getAttribute.call(el, n);
    return typeof v === 'string' ? v : null;
  };
  const id = (attr('id') || '').toLowerCase();
  const geomAttr = attr('geometry') || '';
  const prim = TAG_GEOMETRY[tag] || (geomAttr.match(/primitive\s*:\s*([a-zA-Z]+)/) || [])[1];
  const flatPrim = prim === 'plane' || prim === 'circle' || prim === 'box' || prim === 'cylinder';
  if (!flatPrim) return false;
  const read = (name, key) => {
    const direct = parseNum(attr(name) ?? '');
    if (direct !== null) return direct;
    const m = geomAttr.match(new RegExp(`${key}\\s*:\\s*([-\\d.]+)`));
    return m ? parseNum(m[1]) : 0;
  };
  const sc = (attr('scale') || '1 1 1').split(/\s+/).map((n) => Math.abs(parseNum(n) ?? 1));
  const span = Math.max(read('width', 'width') * sc[0], read('depth', 'depth') * (sc[2] ?? 1),
    read('height', 'height') * (sc[1] ?? 1), read('radius', 'radius') * 2 * sc[0]);
  const rot = (attr('rotation') || '0 0 0').split(/\s+/).map((n) => parseNum(n) ?? 0);
  const lying = (prim === 'plane' || prim === 'circle') ? Math.abs(Math.abs(rot[0]) - 90) < 15 : true;
  const named = /ground|floor|terrain|grass|ocean|sea|water-plane|base-plane/.test(id);
  return (lying && span >= 15) || (named && span >= 8);
}

/**
 * @param {string} markup  raw `markup` string from the LLM envelope
 * @param {object} [opts]
 * @param {number} [opts.maxEntities] remaining entity budget for this payload
 * @param {number} [opts.maxLights]   remaining dynamic-light budget
 * @param {string} [opts.idSeed]      seed for auto-generated ids
 * @returns {{markup:string, topIds:string[], allIds:string[], fog:string|null,
 *            warnings:string[], stats:{entities:number, dropped:number, lights:number}}}
 */
export function sanitizeMarkup(markup, opts = {}) {
  const warnings = [];
  const warn = (m) => { if (warnings.length < 60) warnings.push(m); };
  const maxEntities = opts.maxEntities ?? LIMITS.maxEntities;
  let lightBudget = opts.maxLights ?? LIMITS.maxLights;
  let soundBudget = 4;
  const idSeed = opts.idSeed || Date.now().toString(36);

  if (typeof markup !== 'string') throw new SanitizeError('markup is not a string');
  if (markup.length > LIMITS.maxMarkupChars) throw new SanitizeError('markup is too large');

  // --- 0. Raw pre-scan: cheap, catches things before the parser can reshape them.
  if (DANGEROUS_VALUE.test(markup)) throw new SanitizeError('script-like content');
  const rawTag = markup.match(/<\s*(script|style|link|iframe|object|embed|img|svg|math|meta|base|template)\b/i);
  if (rawTag) throw new SanitizeError(`forbidden <${rawTag[1].toLowerCase()}> tag`);

  // --- 1. Parse into an inert document. DOMParser documents have no browsing
  // context: scripts never execute, <img onerror> never fires, and custom
  // elements (a-box …) are NOT upgraded, so A-Frame code never runs on input.
  const normalized = normalizeSelfClosing(markup);
  const parsed = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><head></head><body>${normalized}</body></html>`, 'text/html'
  );
  // The parser may hoist some tags into <head> (e.g. <title>, <meta>) — anything there is suspect.
  if (parsed.head && parsed.head.children.length) {
    throw new SanitizeError(`forbidden <${parsed.head.children[0].localName}> tag`);
  }
  const body = parsed.body;

  // --- 2. Global forbidden scan over every element, even ones we'd drop.
  for (const el of body.querySelectorAll('*')) {
    const tag = el.localName;
    if (FORBIDDEN_TAGS.has(tag)) throw new SanitizeError(`forbidden <${tag}> tag`);
    if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
      throw new SanitizeError('foreign namespace element');
    }
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) throw new SanitizeError(`event handler attribute "${name}"`);
      if (FORBIDDEN_ATTRS.has(name)) {
        // `src="#generated-ambient"` is meaningless on an entity but not malicious: drop it later.
        if (name === 'src' && isAmbientRef(attr.value)) continue;
        throw new SanitizeError(`forbidden attribute "${name}"`);
      }
      if (name.includes(':')) throw new SanitizeError(`namespaced attribute "${name}"`);
      if (DANGEROUS_VALUE.test(attr.value)) throw new SanitizeError('script-like attribute value');
      // url(...) is only tolerated as `url(#generated-ambient)` (A-Frame's asset syntax).
      for (const m of attr.value.matchAll(/url\s*\(([^)]*)\)?/gi)) {
        if ((m[1] || '').trim().replace(/^['"]|['"]$/g, '') !== `#${AMBIENT_ASSET_ID}`) {
          throw new SanitizeError('url() reference');
        }
      }
    }
  }

  // --- 3. Rebuild into a fresh inert document.
  const outDoc = document.implementation.createHTMLDocument('');
  const outRoot = outDoc.createElement('div');
  const usedIds = new Set();
  const topIds = [];
  const allIds = [];
  let fog = null;
  let entities = 0;
  let dropped = 0;
  let autoCounter = 0;
  let budgetWarned = false;

  function claimId(raw, tag) {
    let id = (raw || '').trim();
    if (id) {
      let fixed = id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, LIMITS.maxIdLength);
      if (!/^[A-Za-z]/.test(fixed)) fixed = `e-${fixed}`.slice(0, LIMITS.maxIdLength);
      if (RESERVED_IDS.includes(fixed) || fixed.startsWith(RESERVED_ID_PREFIX)) {
        warn(`id "${fixed}" is reserved; renamed`);
        fixed = `w-${fixed}`.slice(0, LIMITS.maxIdLength);
      }
      if (fixed !== id) warn(`id "${id}" normalised to "${fixed}"`);
      id = fixed;
    } else {
      id = `auto-${tag.replace(/^a-/, '')}-${idSeed}-${++autoCounter}`;
      warn(`entity without id got "${id}"`);
    }
    // De-duplicate within this payload.
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      warn(`duplicate id "${id}" renamed to "${id}-${n}"`);
      id = `${id}-${n}`;
    }
    if (!ID_RE.test(id)) id = `auto-${idSeed}-${++autoCounter}`;
    usedIds.add(id);
    return id;
  }

  /**
   * Validate a multi-property component string with a validator table.
   * `onProp(key, value)` may return: undefined (use table), a string (override),
   * or null (drop silently). Returns sanitized string or null if empty.
   */
  function sanitizeComponent(name, raw, table, { allowUrlIn = [], onProp, extra = [] } = {}) {
    const pairs = [];
    for (const [key, value] of parseStyle(raw)) {
      if (key === null) { warn(`${name}: malformed "${value}"`); continue; }
      if (/map$/i.test(key) || key === 'src' || key === 'envMap' || key === 'font' || key === 'fontImage') {
        // Texture/font/env references could fetch network resources.
        if (URLISH_VALUE.test(value)) throw new SanitizeError(`${name}.${key} points at a network URL`);
        if (!(onProp && key === 'src')) { warn(`${name}.${key} removed`); continue; }
      }
      if (!allowUrlIn.includes(key) && URLISH_VALUE.test(value)) {
        throw new SanitizeError(`${name}.${key} contains a URL`);
      }
      let out;
      if (onProp) {
        out = onProp(key, value);
        if (out === null) continue;
      }
      if (out === undefined) {
        const validator = table[key];
        if (!validator) { warn(`${name}.${key} not allowed`); continue; }
        out = validator(value);
        if (out === null) { warn(`${name}.${key} invalid value "${value.slice(0, 40)}"`); continue; }
      }
      pairs.push([key, out]);
    }
    for (const pair of extra) if (!pairs.some(([k]) => k === pair[0])) pairs.push(pair);
    return pairs.length ? stringifyStyle(pairs) : null;
  }

  function sanitizeAnimation(attrName, raw) {
    let animKind = null;
    const parsedPairs = parseStyle(raw);
    const propPair = parsedPairs.find(([k]) => k === 'property');
    if (!propPair) { warn(`${attrName}: missing property`); return null; }
    if (parsedPairs.some(([k, v]) => k === 'isRawProperty' && v.trim() !== 'false')) {
      throw new SanitizeError('animation isRawProperty is not allowed');
    }
    const prop = propPair[1].trim();
    animKind = ANIMATABLE[prop];
    if (!animKind) { warn(`${attrName}: property "${prop}" not animatable here`); return null; }
    const valueValidator = ANIM_VALUE_VALIDATORS[animKind];
    return sanitizeComponent(attrName, raw, {}, {
      onProp(key, value) {
        switch (key) {
          case 'property': return prop;
          case 'from': case 'to': {
            const v = valueValidator(value);
            if (v === null) { warn(`${attrName}.${key} invalid`); return null; }
            return v;
          }
          case 'dur': return V.num(LIMITS.minAnimDur, LIMITS.maxAnimDur)(value);
          case 'delay': return V.num(0, 60000)(value);
          case 'dir': return V.oneOf(['normal', 'alternate', 'reverse', ''])(value);
          case 'easing': return EASING_RE.test(value.trim()) ? value.trim() : (warn(`${attrName}.easing invalid`), null);
          case 'loop': {
            const s = value.trim();
            if (s === 'true' || s === 'false') return s;
            const n = parseNum(s);
            return n === null ? null : String(clamp(Math.round(n), 0, 1000));
          }
          case 'autoplay': case 'enabled': case 'round': return V.bool()(value);
          case 'type': return V.oneOf(['color', ''])(value);
          case 'elasticity': return V.num(0, 1000)(value);
          case 'startEvents': case 'pauseEvents': case 'resumeEvents': return V.events()(value);
          case 'isRawProperty': return null;
          default: warn(`${attrName}.${key} not allowed`); return null;
        }
      }
    });
  }

  function sanitizeSound(raw) {
    let hasSrc = false;
    const out = sanitizeComponent('sound', raw, SOUND_VALIDATORS, {
      allowUrlIn: [],
      onProp(key, value) {
        if (key !== 'src') return undefined;
        if (!isAmbientRef(value)) {
          throw new SanitizeError('sound src may only be #generated-ambient');
        }
        hasSrc = true;
        return `#${AMBIENT_ASSET_ID}`;
      }
    });
    if (!hasSrc) { warn('sound without src removed'); return null; }
    return out;
  }

  /** Build the per-tag mapping of hyphenated primitive attributes → validator. */
  function primitiveAttrValidator(tag, attrName) {
    const camel = toCamel(attrName);
    if (tag === 'a-light') {
      if (LIGHT_VALIDATORS[camel]) return { comp: 'light', key: camel, fn: LIGHT_VALIDATORS[camel] };
      return null;
    }
    if (tag === 'a-text') {
      if (attrName === 'font' || attrName === 'font-image') return { drop: true };
      if (TEXT_VALIDATORS[camel]) return { comp: 'text', key: camel, fn: TEXT_VALIDATORS[camel] };
      return null;
    }
    const prim = TAG_GEOMETRY[tag];
    if (prim) {
      if (MESH_GEOMETRIES[prim].includes(camel)) {
        let fn = GEOMETRY_VALIDATORS[camel];
        if (tag === 'a-sky' && camel === 'radius') fn = V.num(1, LIMITS.maxSkyRadius);
        return { comp: 'geometry', key: camel, fn };
      }
      // material mappings; A-Frame renames `fog`/`visible` to material-fog/material-visible.
      const matKey = attrName === 'material-fog' ? 'fog' : attrName === 'material-visible' ? 'visible' : camel;
      if (MATERIAL_VALIDATORS[matKey] && attrName !== 'fog' && attrName !== 'visible') {
        return { comp: 'material', key: matKey, fn: MATERIAL_VALIDATORS[matKey] };
      }
      if (/(map|src|env-map)$/.test(attrName)) return { drop: true };
    }
    return null;
  }

  function buildElement(src, depth) {
    const tag = src.localName;
    if (tag === 'a-scene' || tag === 'div' || tag === 'span' || tag === 'p') {
      // Wrapper elements: unwrap children (a-scene fog is lifted).
      if (tag === 'a-scene' && src.hasAttribute('fog')) {
        fog = sanitizeComponent('fog', src.getAttribute('fog'), FOG_VALIDATORS) || fog;
      }
      if (tag !== 'a-scene') warn(`<${tag}> wrapper unwrapped`);
      return [...src.children].flatMap((c) => buildElement(c, depth));
    }
    if (!ALLOWED_TAGS.has(tag)) {
      dropped += 1 + src.querySelectorAll('*').length;
      warn(`<${tag}> not allowed; removed with its children`);
      return [];
    }
    if (depth > 12) { dropped++; warn('nesting too deep; subtree removed'); return []; }
    if (entities >= maxEntities) {
      dropped += 1 + src.querySelectorAll('*').length;
      if (!budgetWarned) warn(`entity budget (${maxEntities}) reached; extra entities removed`);
      budgetWarned = true;
      return [];
    }

    // Dynamic lights are capped (each one adds per-fragment cost on every material).
    if ((tag === 'a-light' || src.hasAttribute('light')) && lightBudget <= 0) {
      warn(`light budget reached; light on "${src.getAttribute('id') || tag}" removed`);
      if (tag === 'a-light') { dropped++; return []; }
    }

    const el = outDoc.createElement(tag);
    entities++;
    const id = claimId(src.getAttribute('id'), tag);
    el.setAttribute('id', id);
    allIds.push(id);

    const primitiveGroups = {}; // track which geometry keys were explicitly set for perf defaults
    let lightAdded = false;

    for (const attr of src.attributes) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name === 'id') continue;
      if (name === 'src') { warn('src attribute removed'); continue; }

      // Free-text attribute on <a-text value="…">: URL text is fine (rendered as glyphs).
      if (name !== 'value' && name !== 'text' && URLISH_VALUE.test(value)) {
        throw new SanitizeError(`attribute "${name}" contains a URL`);
      }

      if (name === 'class') {
        const keep = value.split(/\s+/).includes('interactive');
        if (keep) el.setAttribute('class', 'interactive');
        else if (value.trim()) warn(`class "${value}" removed (only "interactive" is allowed)`);
        continue;
      }
      if (name === 'position') {
        const v = V.vec3(-LIMITS.maxCoord, LIMITS.maxCoord)(value);
        if (v) el.setAttribute('position', v); else warn(`${id}.position invalid`);
        continue;
      }
      if (name === 'rotation') {
        const v = V.vec3(-36000, 36000)(value);
        if (v) el.setAttribute('rotation', v); else warn(`${id}.rotation invalid`);
        continue;
      }
      if (name === 'scale') {
        const v = V.vec3(-LIMITS.maxScale, LIMITS.maxScale, { nonZero: true, scalar: true })(value);
        if (v) el.setAttribute('scale', v); else warn(`${id}.scale invalid`);
        continue;
      }
      if (name === 'visible') {
        const v = V.bool()(value);
        if (v) el.setAttribute('visible', v);
        continue;
      }
      if (name === 'geometry') {
        const primMatch = parseStyle(value).find(([k]) => k === 'primitive');
        const prim = primMatch ? primMatch[1].trim() : (TAG_GEOMETRY[tag] || 'box');
        if (!MESH_GEOMETRIES[prim]) { warn(`${id}: geometry primitive "${prim}" not allowed`); continue; }
        const allowed = new Set(MESH_GEOMETRIES[prim]);
        const table = {};
        for (const k of allowed) table[k] = GEOMETRY_VALIDATORS[k];
        table.primitive = () => prim;
        const perf = PERF_DEFAULTS[tag === 'a-sky' ? 'sky' : prim] || {};
        const present = new Set(parseStyle(value).map(([k]) => k));
        const extra = Object.entries(perf).filter(([k]) => !present.has(k)).map(([k, v]) => [k, String(v)]);
        const out = sanitizeComponent(`${id}.geometry`, value, table, { extra });
        if (out) el.setAttribute('geometry', out);
        primitiveGroups.geometryComponent = true;
        continue;
      }
      if (name === 'material') {
        const out = sanitizeComponent(`${id}.material`, value, MATERIAL_VALIDATORS);
        if (out) el.setAttribute('material', out);
        continue;
      }
      if (name === 'light') {
        if (lightBudget <= 0) continue;
        const out = sanitizeComponent(`${id}.light`, value, LIGHT_VALIDATORS);
        if (out) { el.setAttribute('light', out); lightAdded = true; }
        continue;
      }
      if (name === 'text') {
        const out = sanitizeComponent(`${id}.text`, value, TEXT_VALIDATORS, { allowUrlIn: ['value'] });
        if (out) el.setAttribute('text', out);
        continue;
      }
      if (name === 'sound') {
        if (soundBudget <= 0) { warn('sound budget reached'); continue; }
        const out = sanitizeSound(value);
        if (out) { el.setAttribute('sound', out); soundBudget--; }
        continue;
      }
      if (name === 'fog') {
        // Fog is a scene component; lift it out so the injector can apply it to <a-scene>.
        fog = sanitizeComponent('fog', value, FOG_VALIDATORS) || fog;
        continue;
      }
      if (name === 'animation' || /^animation__[a-z0-9_-]{1,32}$/.test(name)) {
        if (name.startsWith('animation__ws')) { warn(`${name} is reserved`); continue; }
        const out = sanitizeAnimation(name, value);
        if (out) el.setAttribute(name, out);
        continue;
      }

      // Primitive attribute mappings (color="red", radius="2", intensity="1" …).
      const mapped = primitiveAttrValidator(tag, name);
      if (mapped) {
        if (mapped.drop) { warn(`${id}.${name} removed`); continue; }
        if (mapped.comp === 'light' && lightBudget <= 0) continue;
        if (mapped.comp === 'text' && name === 'value') {
          el.setAttribute('value', V.text(LIMITS.maxTextLength)(value));
          continue;
        }
        if (URLISH_VALUE.test(value) && !(mapped.comp === 'text')) {
          throw new SanitizeError(`attribute "${name}" contains a URL`);
        }
        const out = mapped.fn(value);
        if (out === null) { warn(`${id}.${name} invalid value`); continue; }
        el.setAttribute(name, out);
        if (mapped.comp === 'geometry') primitiveGroups[mapped.key] = true;
        continue;
      }

      warn(`${id}: attribute "${name}" not allowed`);
    }

    // Perf defaults for mesh primitives when tessellation wasn't specified.
    if (TAG_GEOMETRY[tag] && !primitiveGroups.geometryComponent) {
      const perf = PERF_DEFAULTS[tag === 'a-sky' ? 'sky' : TAG_GEOMETRY[tag]] || {};
      for (const [k, v] of Object.entries(perf)) {
        if (!primitiveGroups[k]) el.setAttribute(toKebab(k), String(v));
      }
    }

    if (tag === 'a-light' || lightAdded) lightBudget--;

    // Children (a-text / a-light can technically have children too; allow uniformly).
    for (const child of src.children) {
      for (const built of buildElement(child, depth + 1)) el.appendChild(built);
    }
    return [el];
  }

  for (const child of body.children) {
    for (const built of buildElement(child, 0)) {
      outRoot.appendChild(built);
      topIds.push(built.getAttribute('id'));
    }
  }

  if (body.textContent && [...body.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
    warn('stray text outside entities removed');
  }

  return {
    markup: outRoot.innerHTML,
    topIds,
    allIds,
    fog,
    warnings,
    stats: { entities, dropped, lights: (opts.maxLights ?? LIMITS.maxLights) - lightBudget }
  };
}

function isAmbientRef(value) {
  const s = String(value).trim().replace(/^url\(\s*(.*?)\s*\)$/i, '$1');
  return s === `#${AMBIENT_ASSET_ID}`;
}

/** Sanitizes a scene-level fog string on its own (used by import + injector). */
export function sanitizeFog(raw) {
  if (!raw) return null;
  if (DANGEROUS_VALUE.test(raw) || URLISH_VALUE.test(raw)) throw new SanitizeError('fog contains a URL');
  const out = [];
  for (const [k, v] of parseStyle(raw)) {
    if (!k || !FOG_VALIDATORS[k]) continue;
    const s = FOG_VALIDATORS[k](v);
    if (s !== null) out.push([k, s]);
  }
  return out.length ? stringifyStyle(out) : null;
}
