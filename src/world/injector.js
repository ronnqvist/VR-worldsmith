/**
 * World injector: owns the generated world.
 *
 * Design notes
 * ------------
 * • Canonical state lives in an INERT MIRROR document (createHTMLDocument), not
 *   in the live A-Frame DOM. A-Frame does not flush runtime state (animations,
 *   grabbed positions, defaults) back into attributes, so serialising the live
 *   DOM would be lossy and bloated. Every change is applied to the mirror first,
 *   then reflected into the live container. Undo, persistence and the LLM context
 *   are all derived from the mirror.
 * • Everything entering the mirror has passed through `sanitizeMarkup` — including
 *   stored/imported worlds (localStorage is shared by every page on the same
 *   origin, e.g. all of someone's *.github.io projects, so it is untrusted too).
 * • The injector touches only the A-Frame container + scene element handed to it.
 *   It never queries the page's 2D UI DOM. Side-effects for the app shell (default
 *   sky/lights visibility) are reported through hooks.
 */
import { sanitizeMarkup, sanitizeFog, isSkyOrGround, SanitizeError } from './sanitize.js';
import { LIMITS, UNDO_LIMIT, CONTEXT_BUDGET_CHARS } from '../core/config.js';
import { createLogger } from '../core/log.js';

const log = createLogger('injector');
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Raw attribute string (A-Frame's getAttribute returns parsed component data on live entities). */
const rawAttr = (el, name) => Element.prototype.getAttribute.call(el, name);
const ENTER_MS = 650;
const EXIT_MS = 280;

/**
 * @param {object} p
 * @param {HTMLElement} p.container  live <a-entity id="generated-world">
 * @param {HTMLElement} p.sceneEl    live <a-scene> (for fog)
 * @param {(state:{markup:string,fog:string|null})=>void} [p.onChange]
 * @param {{onEnvironment?:(env:{hasSky:boolean, hasAmbient:boolean, hasDirectional:boolean, hasGround:boolean})=>void}} [p.hooks]
 */
export function createInjector({ container, sceneEl, onChange = () => {}, hooks = {} }) {
  const liveDoc = container.ownerDocument;
  const mirrorDoc = liveDoc.implementation.createHTMLDocument('worldsmith-mirror');
  let root = mirrorDoc.createElement('div');
  let fog = null;
  let mode = 'vr';
  const undoStack = [];

  /* ---------------- mirror helpers ---------------- */

  const snapshot = () => ({ markup: root.innerHTML, fog });
  const count = () => root.querySelectorAll('*').length;
  const byIdIn = (scope, id) => (ID_RE.test(id) ? scope.querySelector(`[id="${id}"]`) : null);
  const liveById = (id) => byIdIn(container, id);

  function pushUndo(snap) {
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function lightCount(scope = root) {
    return scope.querySelectorAll('a-light, [light]').length;
  }

  function emitChange() {
    const hasSky = !!root.querySelector('a-sky');
    // Each shell light steps aside only for the same kind of light in the world, so a
    // world with just a directional light still gets the shell's ambient fill.
    const types = [...root.querySelectorAll('a-light, [light]')].map((el) => (el.localName === 'a-light'
      ? (el.getAttribute('type') || 'directional')
      : ((el.getAttribute('light') || '').match(/type\s*:\s*(\w+)/) || [null, 'directional'])[1]));
    const hasAmbient = types.includes('ambient') || types.includes('hemisphere');
    const hasDirectional = types.includes('directional');
    const hasGround = [...root.querySelectorAll('*')].some((el) => el.localName !== 'a-sky' && isSkyOrGround(el));
    try { hooks.onEnvironment?.({ hasSky, hasAmbient, hasDirectional, hasGround }); } catch (e) { log.warn('hook failed', e); }
    try { onChange(snapshot()); } catch (e) { log.warn('onChange failed', e); }
  }

  /* ---------------- live (A-Frame) helpers ---------------- */

  function hasScaleAnimation(node) {
    for (const a of node.attributes) {
      if (a.name.startsWith('animation') && /property\s*:\s*scale\b/.test(a.value)) return true;
    }
    return false;
  }

  /** Imports a mirror node into the live document, decorated with an entry transition. */
  function toLive(mirrorNode, { transition = true, delay = 0 } = {}) {
    // importNode from the inert mirror: the copy becomes a real custom element (A-Frame
    // upgrades it) only when connected to the live scene.
    const node = liveDoc.importNode(mirrorNode, true);
    if (transition && node.localName !== 'a-sky' && node.localName !== 'a-light' && !hasScaleAnimation(node)) {
      const target = rawAttr(node, 'scale') || '1 1 1';
      node.setAttribute('scale', '0.001 0.001 0.001');
      node.setAttribute('animation__wsin',
        `property: scale; from: 0.001 0.001 0.001; to: ${target}; dur: ${ENTER_MS}; delay: ${delay}; easing: easeOutBack`);
      // Remove the helper animation once done so it never conflicts with later edits.
      node.addEventListener('animationcomplete__wsin', () => node.removeAttribute('animation__wsin'), { once: true });
    }
    applyModeVisibility(node);
    return node;
  }

  function removeLive(node, { transition = true } = {}) {
    if (!node || !node.parentNode) return;
    node.removeAttribute('id'); // free the id immediately so a replacement can claim it
    if (!transition || node.localName === 'a-sky' || node.localName === 'a-light' || !node.hasLoaded) {
      node.parentNode.removeChild(node);
      return;
    }
    node.setAttribute('animation__wsout',
      `property: scale; to: 0.001 0.001 0.001; dur: ${EXIT_MS}; easing: easeInQuad`);
    setTimeout(() => node.parentNode && node.parentNode.removeChild(node), EXIT_MS + 40);
  }

  function applyModeVisibility(node) {
    const targets = [node, ...node.querySelectorAll('*')];
    for (const el of targets) {
      // Classify using the mirror copy: the live node may carry transition overrides (tiny scale).
      const mirrorEl = byIdIn(root, rawAttr(el, 'id') || '');
      if (!isSkyOrGround(mirrorEl || el)) continue;
      if (mode === 'ar') {
        el.setAttribute('visible', 'false');
      } else {
        const v = mirrorEl ? rawAttr(mirrorEl, 'visible') : null;
        el.setAttribute('visible', v === 'false' ? 'false' : 'true');
      }
    }
  }

  function applyFogLive() {
    if (fog && mode !== 'ar') sceneEl.setAttribute('fog', fog);
    else if (sceneEl.hasAttribute('fog')) sceneEl.removeAttribute('fog');
  }

  /** Replaces the whole live world with the mirror's current content. */
  function rebuildLive({ transition = true } = {}) {
    for (const child of [...container.children]) removeLive(child, { transition });
    let i = 0;
    for (const child of root.children) {
      container.appendChild(toLive(child, { transition, delay: Math.min(i++ * 25, 600) }));
    }
    applyFogLive();
  }

  /* ---------------- public operations ---------------- */

  /**
   * Applies a validated LLM envelope. Sanitizes `markup` (throws SanitizeError on
   * forbidden content). Returns a report for UI/diagnostics.
   */
  function applyEnvelope(env) {
    const before = snapshot();
    const isCreate = env.action === 'create_world' || count() === 0;
    const report = { action: isCreate ? 'create_world' : 'update_world', added: [], replaced: [], removed: [], warnings: [] };

    const clean = sanitizeMarkup(env.markup || '', {
      maxEntities: LIMITS.maxEntities,
      maxLights: LIMITS.maxLights
    });
    report.warnings.push(...clean.warnings);
    const incoming = mirrorDoc.createElement('div');
    incoming.innerHTML = clean.markup;

    try {
      if (isCreate) {
        root = incoming;
        fog = clean.fog;
        report.added = [...root.children].map((c) => c.id);
        rebuildLive({ transition: true });
      } else {
        // 1. Removals (only ever inside the generated world).
        for (const id of env.removed_ids || []) {
          const m = byIdIn(root, String(id));
          if (!m) { report.warnings.push(`removed_ids: "${id}" not found`); continue; }
          m.remove();
          removeLive(liveById(id));
          report.removed.push(id);
        }
        // 2. Merge by id.
        for (const node of [...incoming.children]) {
          const id = node.id;
          const existing = byIdIn(root, id);
          // Nested ids inside the new node that already exist elsewhere would create
          // duplicates — the newer definition wins, the stale one is removed.
          for (const inner of node.querySelectorAll('[id]')) {
            const dup = byIdIn(root, inner.id);
            if (dup && dup !== existing && !(existing && existing.contains(dup))) {
              dup.remove();
              removeLive(liveById(inner.id), { transition: false });
              report.warnings.push(`duplicate id "${inner.id}" replaced`);
            }
          }
          if (existing) {
            existing.replaceWith(node);
            const old = liveById(id);
            if (old && old.parentNode) {
              const fresh = toLive(node, { transition: false });
              old.parentNode.insertBefore(fresh, old);
              removeLive(old, { transition: false });
            } else {
              container.appendChild(toLive(node));
            }
            report.replaced.push(id);
          } else {
            root.appendChild(node);
            container.appendChild(toLive(node, { delay: Math.min(report.added.length * 25, 600) }));
            report.added.push(id);
          }
        }
        if (clean.fog) fog = clean.fog;
        // 3. Post-merge budgets: newest additions are trimmed first.
        enforceBudgets(report);
        applyFogLive();
      }
    } catch (err) {
      log.error('live apply failed, rolling back', err);
      restore(before, { transition: false });
      throw err;
    }

    pushUndo(before);
    emitChange();
    return report;
  }

  function enforceBudgets(report) {
    let over = count() - LIMITS.maxEntities;
    while (over > 0 && report.added.length) {
      const id = report.added.pop();
      const m = byIdIn(root, id);
      if (!m) continue;
      over -= 1 + m.querySelectorAll('*').length;
      m.remove();
      removeLive(liveById(id), { transition: false });
      report.warnings.push(`entity budget: "${id}" not added`);
    }
    let lightsOver = lightCount() - LIMITS.maxLights;
    if (lightsOver > 0) {
      const lights = [...root.querySelectorAll('a-light, [light]')].reverse();
      for (const l of lights) {
        if (lightsOver <= 0) break;
        const live = liveById(l.id);
        if (l.localName === 'a-light') { l.remove(); removeLive(live, { transition: false }); }
        else { l.removeAttribute('light'); live?.removeAttribute('light'); }
        lightsOver--;
        report.warnings.push(`light budget: light on "${l.id}" removed`);
      }
    }
  }

  /** Restores a snapshot (from undo or storage). Markup is re-sanitized. */
  function restore(snap, { transition = true } = {}) {
    let clean;
    try {
      clean = sanitizeMarkup(snap?.markup || '', { maxEntities: LIMITS.maxEntities, maxLights: LIMITS.maxLights });
    } catch (err) {
      if (err instanceof SanitizeError) {
        log.error('stored world failed sanitization; starting empty', err.reason);
        clean = { markup: '', fog: null };
      } else throw err;
    }
    const next = mirrorDoc.createElement('div');
    next.innerHTML = clean.markup;
    root = next;
    let f = null;
    try { f = sanitizeFog(snap?.fog) || clean.fog; } catch { f = null; }
    fog = f;
    rebuildLive({ transition });
  }

  /** Loads a world (stored, saved, imported). Undoable unless `pushToUndo:false`. */
  function load(snap, { pushToUndo = true, transition = true } = {}) {
    const before = snapshot();
    restore(snap, { transition });
    if (pushToUndo) pushUndo(before);
    emitChange();
  }

  function undo() {
    const prev = undoStack.pop();
    if (!prev) return false;
    restore(prev, { transition: true });
    emitChange();
    return true;
  }

  function reset() {
    if (count() === 0 && !fog) return;
    pushUndo(snapshot());
    root = mirrorDoc.createElement('div');
    fog = null;
    rebuildLive({ transition: true });
    emitChange();
  }

  /** Deletes one entity (grab+squeeze). Undoable. */
  function removeEntity(id) {
    const m = byIdIn(root, id);
    if (!m) return false;
    pushUndo(snapshot());
    m.remove();
    removeLive(liveById(id));
    emitChange();
    return true;
  }

  /**
   * Commits a transform made interactively (grab). Values are local to the
   * entity's parent, exactly what the attribute means. Undoable.
   */
  function commitTransform(id, { position, rotation }) {
    const m = byIdIn(root, id);
    if (!m) return false;
    pushUndo(snapshot());
    const clampCoord = (v) => Math.max(-LIMITS.maxCoord, Math.min(LIMITS.maxCoord, v));
    const f = (n) => String(Math.round(n * 1000) / 1000);
    if (position) m.setAttribute('position', [position.x, position.y, position.z].map((v) => f(clampCoord(v))).join(' '));
    if (rotation) m.setAttribute('rotation', [rotation.x, rotation.y, rotation.z].map(f).join(' '));
    emitChange();
    return true;
  }

  function setMode(next) {
    mode = next === 'ar' ? 'ar' : 'vr';
    for (const child of container.children) applyModeVisibility(child);
    applyFogLive();
  }

  /**
   * Compact world serialization for the LLM. Full markup while it fits in the
   * budget; past that, remaining top-level entities are summarised as
   * `id <tag> @ position` so the model can still reference/remove them.
   */
  function serializeForContext(budget = CONTEXT_BUDGET_CHARS) {
    const full = root.innerHTML;
    const header = fog ? `<!-- scene fog: ${fog} -->\n` : '';
    if (full.length + header.length <= budget) {
      return { text: header + full, truncated: false, entities: count() };
    }
    const parts = [header];
    let used = header.length;
    const omitted = [];
    for (const child of root.children) {
      const html = child.outerHTML;
      if (used + html.length < budget * 0.85) { parts.push(html); used += html.length; }
      else omitted.push(`${child.id} <${child.localName}> @ ${child.getAttribute('position') || '0 0 0'}`);
    }
    parts.push(`\n<!-- ${omitted.length} more top-level entities omitted for brevity (ids still valid): ${omitted.join('; ')} -->`);
    return { text: parts.join('\n'), truncated: true, entities: count() };
  }

  return {
    applyEnvelope,
    load,
    undo,
    reset,
    removeEntity,
    commitTransform,
    setMode,
    serializeForContext,
    getMarkup: () => root.innerHTML,
    getFog: () => fog,
    getSnapshot: snapshot,
    count,
    canUndo: () => undoStack.length > 0,
    hasEntity: (id) => !!byIdIn(root, id),
    topLevelIds: () => [...root.children].map((c) => c.id)
  };
}
