/**
 * .worldsmith.json export/import. Pure data transforms: no DOM. Markup
 * re-sanitization is injected by the caller (`sanitize` option) so this module
 * stays testable under Node; the injector re-sanitizes on load as well.
 */
import { APP_VERSION } from '../core/config.js';
import { normalizeSettings, normalizeSavedWorld, normalizeHistoryEntry, normalizeWorld } from './store.js';

export const EXPORT_FORMAT = 'worldsmith';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** Builds the export object. The API key is never included. */
export function buildExport({ settings, savedWorlds = [], history = [], currentWorld = null }) {
  // eslint-disable-next-line no-unused-vars
  const { apiKey, ...safeSettings } = settings || {};
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    app: APP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: normalizeSettings(safeSettings),
    currentWorld: normalizeWorld(currentWorld),
    savedWorlds: savedWorlds.map(normalizeSavedWorld).filter(Boolean),
    history: history.map(normalizeHistoryEntry).filter(Boolean)
  };
}

export function exportFilename(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `worlds-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.worldsmith.json`;
}

/**
 * Validates + normalises an imported file's parsed JSON.
 * @param {any} obj
 * @param {{sanitize?:(markup:string)=>string}} [opts] returns sanitized markup or throws
 * @returns {{ok:true, data:object, warnings:string[]} | {ok:false, errors:string[]}}
 */
export function validateImport(obj, { sanitize } = {}) {
  const errors = [];
  const warnings = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['File is not a JSON object.'] };
  if (obj.format !== EXPORT_FORMAT) errors.push('Not a Worldsmith export (missing "format": "worldsmith").');
  if (typeof obj.version !== 'number' || obj.version < 1) errors.push('Missing or invalid "version".');
  else if (obj.version > EXPORT_VERSION) errors.push(`File version ${obj.version} is newer than this app supports (${EXPORT_VERSION}).`);
  if (obj.settings !== undefined && (typeof obj.settings !== 'object' || Array.isArray(obj.settings))) errors.push('"settings" must be an object.');
  if (obj.savedWorlds !== undefined && !Array.isArray(obj.savedWorlds)) errors.push('"savedWorlds" must be an array.');
  if (obj.history !== undefined && !Array.isArray(obj.history)) errors.push('"history" must be an array.');
  if (errors.length) return { ok: false, errors };

  if (obj.settings && 'apiKey' in obj.settings) warnings.push('An API key in the file was ignored.');

  const clean = (w, label) => {
    if (!w) return null;
    if (!sanitize) return w;
    try {
      return { ...w, markup: sanitize(w.markup) };
    } catch (err) {
      warnings.push(`${label} skipped: ${err.reason || err.message}`);
      return null;
    }
  };

  const savedWorlds = [];
  for (const raw of (obj.savedWorlds || []).slice(0, 100)) {
    const w = clean(normalizeSavedWorld(raw), `World "${raw?.name ?? '?'}"`);
    if (w) savedWorlds.push(w); else if (!raw?.name) warnings.push('A saved world without a name was skipped.');
  }
  const history = (obj.history || []).map(normalizeHistoryEntry).filter(Boolean);
  const currentWorld = clean(normalizeWorld(obj.currentWorld), 'Current world');

  return {
    ok: true,
    warnings,
    data: { settings: normalizeSettings(obj.settings || {}), savedWorlds, history, currentWorld }
  };
}

/**
 * Combines existing data with an import.
 * merge: saved worlds unioned (name clashes get " (2)"), history concatenated
 *        and time-sorted, settings kept as-is (except none from file).
 * replace: imported data wins wholesale (API key always stays local).
 */
export function combineImport(current, incoming, mode = 'merge', historyLimit = 20) {
  if (mode === 'replace') {
    return {
      settings: incoming.settings,
      savedWorlds: incoming.savedWorlds,
      history: incoming.history.slice(-historyLimit),
      currentWorld: incoming.currentWorld
    };
  }
  const names = new Set(current.savedWorlds.map((w) => w.name));
  const merged = [...current.savedWorlds];
  for (const w of incoming.savedWorlds) {
    let name = w.name;
    if (names.has(name)) {
      // Identical content → skip; otherwise rename.
      const same = current.savedWorlds.find((c) => c.name === name && c.markup === w.markup);
      if (same) continue;
      let n = 2;
      while (names.has(`${w.name} (${n})`)) n++;
      name = `${w.name} (${n})`.slice(0, 80);
    }
    names.add(name);
    merged.push({ ...w, name });
  }
  const seen = new Set();
  const history = [...current.history, ...incoming.history]
    .sort((a, b) => a.at - b.at)
    .filter((h) => { const k = `${h.at}|${h.prompt}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(-historyLimit);
  return { settings: current.settings, savedWorlds: merged, history, currentWorld: current.currentWorld };
}
