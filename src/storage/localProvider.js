/**
 * Storage providers.
 *
 * @typedef {object} StorageProvider
 * An async key/value store holding JSON-serialisable values. App logic only
 * talks to this interface (through src/storage/store.js), never to
 * localStorage directly.
 * @property {(key:string) => Promise<any>} get       resolves undefined when missing
 * @property {(key:string, value:any) => Promise<void>} set
 * @property {(key:string) => Promise<void>} remove
 * @property {() => Promise<string[]>} keys
 *
 * FUTURE BACKEND: to sync worlds across devices, implement this same interface
 * on top of e.g. Convex (queries for get/keys, mutations for set/remove) and
 * pass it to `createStore()` in src/main.js. Keep the API key local-only even
 * then — it should never leave the device except to openrouter.ai.
 */

export class LocalStorageProvider {
  /** @param {{namespace?:string, storage?:Storage}} [opts] */
  constructor({ namespace = 'worldsmith:v1:', storage = globalThis.localStorage } = {}) {
    this.ns = namespace;
    this.storage = storage;
  }

  async get(key) {
    const raw = this.storage.getItem(this.ns + key);
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  }

  async set(key, value) {
    try {
      this.storage.setItem(this.ns + key, JSON.stringify(value));
    } catch (err) {
      // QuotaExceededError (≈5 MB per origin) — surface a clear message.
      const e = new Error('Local storage is full. Delete some saved worlds or export and reset.');
      e.userMessage = e.message;
      e.cause = err;
      throw e;
    }
  }

  async remove(key) { this.storage.removeItem(this.ns + key); }

  async keys() {
    const out = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k && k.startsWith(this.ns)) out.push(k.slice(this.ns.length));
    }
    return out;
  }
}

/** In-memory provider: unit tests, and fallback when localStorage is blocked. */
export class MemoryProvider {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined; }
  async set(key, value) { this.map.set(key, structuredClone(value)); }
  async remove(key) { this.map.delete(key); }
  async keys() { return [...this.map.keys()]; }
}

/** Picks localStorage when usable, otherwise memory (e.g. strict privacy modes). */
export function createDefaultProvider() {
  try {
    const probe = '__worldsmith_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return new LocalStorageProvider();
  } catch {
    return new MemoryProvider();
  }
}
