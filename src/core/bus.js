/**
 * Minimal synchronous event bus used to decouple modules (UI ↔ pipeline ↔ XR).
 * Listener exceptions are isolated so one broken subscriber can't break others.
 */
export function createBus() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    once(type, fn) {
      const off = this.on(type, (p) => { off(); fn(p); });
      return off;
    },
    emit(type, payload) {
      const set = map.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (err) { console.error(`[bus] listener for "${type}" failed`, err); }
      }
    }
  };
}

export const bus = createBus();
