/**
 * Domain-level persistence API built on any StorageProvider.
 * Values read back are re-validated: storage is shared by every page on the
 * same origin, so it is treated as untrusted input.
 */
import { DEFAULT_SETTINGS, HISTORY_LIMIT, LIMITS } from '../core/config.js';

const K = { apiKey: 'apiKey', settings: 'settings', world: 'world', history: 'history', worlds: 'worlds', speech: 'speech' };
const MAX_SAVED_WORLDS = 100;

const str = (v, max, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const num = (v, lo, hi, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Coerces arbitrary input into a valid settings object (unknown keys dropped). */
export function normalizeSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_SETTINGS;
  const model = str(s.model, 120, d.model).trim();
  return {
    model: /^[\w.\-/:@]+$/.test(model) ? model : d.model,
    referer: str(s.referer, 200, d.referer),
    title: str(s.title, 100, d.title),
    temperature: num(s.temperature, 0, 2, d.temperature),
    maxTokens: Math.round(num(s.maxTokens, 256, 64000, d.maxTokens)),
    ttsMuted: bool(s.ttsMuted, d.ttsMuted),
    vignette: bool(s.vignette, d.vignette),
    smoothSpeed: num(s.smoothSpeed, 0.5, 5, d.smoothSpeed),
    inputMode: ['auto', 'voice', 'keyboard'].includes(s.inputMode) ? s.inputMode : d.inputMode,
    diagnostics: bool(s.diagnostics, d.diagnostics),
    preferMR: bool(s.preferMR, d.preferMR),
    showStats: bool(s.showStats, d.showStats)
  };
}

export function normalizeWorld(w) {
  if (!w || typeof w !== 'object' || typeof w.markup !== 'string') return null;
  if (w.markup.length > LIMITS.maxMarkupChars) return null;
  return { markup: w.markup, fog: typeof w.fog === 'string' ? w.fog.slice(0, 300) : null };
}

export function normalizeHistoryEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.prompt !== 'string' || !e.prompt.trim()) return null;
  return {
    prompt: e.prompt.slice(0, 2000),
    narration: str(e.narration, LIMITS.maxNarrationChars),
    action: ['create_world', 'update_world'].includes(e.action) ? e.action : undefined,
    at: num(e.at, 0, 8.64e15, Date.now())
  };
}

export function normalizeSavedWorld(w) {
  const world = normalizeWorld(w);
  if (!world || typeof w.name !== 'string' || !w.name.trim()) return null;
  return {
    name: w.name.trim().slice(0, 80),
    ...world,
    createdAt: num(w.createdAt, 0, 8.64e15, Date.now()),
    updatedAt: num(w.updatedAt, 0, 8.64e15, Date.now())
  };
}

/** @param {import('./localProvider.js').StorageProvider} provider */
export function createStore(provider) {
  return {
    provider,

    async getSettings() { return normalizeSettings(await provider.get(K.settings)); },
    async saveSettings(partial) {
      const next = normalizeSettings({ ...(await this.getSettings()), ...partial });
      await provider.set(K.settings, next);
      return next;
    },

    async getApiKey() { const k = await provider.get(K.apiKey); return typeof k === 'string' ? k : ''; },
    async setApiKey(key) {
      const k = String(key || '').trim();
      if (k) await provider.set(K.apiKey, k); else await provider.remove(K.apiKey);
    },

    async getWorld() { return normalizeWorld(await provider.get(K.world)); },
    async saveWorld(snap) {
      const w = normalizeWorld(snap);
      if (w && w.markup) await provider.set(K.world, w); else await provider.remove(K.world);
    },

    async getHistory() {
      const h = await provider.get(K.history);
      return Array.isArray(h) ? h.map(normalizeHistoryEntry).filter(Boolean).slice(-HISTORY_LIMIT) : [];
    },
    async addHistory(entry) {
      const e = normalizeHistoryEntry({ at: Date.now(), ...entry });
      if (!e) return this.getHistory();
      const h = [...(await this.getHistory()), e].slice(-HISTORY_LIMIT);
      await provider.set(K.history, h);
      return h;
    },
    async setHistory(list) {
      const h = (Array.isArray(list) ? list : []).map(normalizeHistoryEntry).filter(Boolean).slice(-HISTORY_LIMIT);
      await provider.set(K.history, h);
      return h;
    },
    async clearHistory() { await provider.remove(K.history); },

    async listWorlds() {
      const w = await provider.get(K.worlds);
      return Array.isArray(w) ? w.map(normalizeSavedWorld).filter(Boolean).slice(0, MAX_SAVED_WORLDS) : [];
    },
    async setWorlds(list) {
      const w = (Array.isArray(list) ? list : []).map(normalizeSavedWorld).filter(Boolean).slice(0, MAX_SAVED_WORLDS);
      await provider.set(K.worlds, w);
      return w;
    },
    async saveNamedWorld(name, snap) {
      const now = Date.now();
      const list = await this.listWorlds();
      const i = list.findIndex((w) => w.name === name.trim());
      const entry = normalizeSavedWorld({ name, ...snap, createdAt: i >= 0 ? list[i].createdAt : now, updatedAt: now });
      if (!entry) throw new Error('Nothing to save — the world is empty.');
      if (i >= 0) list[i] = entry; else list.unshift(entry);
      return this.setWorlds(list);
    },
    async deleteNamedWorld(name) {
      return this.setWorlds((await this.listWorlds()).filter((w) => w.name !== name));
    },

    /** Remembers that SpeechRecognition failed on this browser so we route to the keyboard. */
    async getSpeechStatus() { const s = await provider.get(K.speech); return s && typeof s === 'object' ? s : {}; },
    async setSpeechStatus(s) { await provider.set(K.speech, s); }
  };
}
