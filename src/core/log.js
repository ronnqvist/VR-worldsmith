/**
 * Diagnostics logger: ring buffer + optional console mirroring. The in-VR and
 * DOM diagnostics views subscribe via `onLog`. Toggled from settings.
 */
const MAX = 300;
const entries = [];
const listeners = new Set();
let verbose = false;

export function setDiagnostics(on) { verbose = !!on; }
export function isDiagnostics() { return verbose; }

function push(level, scope, args) {
  const msg = args.map((a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const entry = { t: Date.now(), level, scope, msg };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  if (verbose || level === 'error' || level === 'warn') {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${scope}]`, ...args);
  }
  for (const l of listeners) { try { l(entry); } catch { /* ignore */ } }
}

export function createLogger(scope) {
  return {
    debug: (...a) => push('debug', scope, a),
    info: (...a) => push('info', scope, a),
    warn: (...a) => push('warn', scope, a),
    error: (...a) => push('error', scope, a)
  };
}

export function getLogEntries() { return entries.slice(); }
export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
