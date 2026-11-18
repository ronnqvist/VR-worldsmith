/**
 * Error types + a global error boundary. `UserFacingError.userMessage` is the
 * short sentence shown in VR captions / DOM toasts.
 */
import { createLogger } from './log.js';

const log = createLogger('errors');

export class UserFacingError extends Error {
  constructor(userMessage, { cause, code, detail } = {}) {
    super(userMessage);
    this.name = 'UserFacingError';
    this.userMessage = userMessage;
    this.code = code || 'error';
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

export function toUserMessage(err) {
  if (!err) return 'Something went wrong.';
  if (err.userMessage) return err.userMessage;
  if (err.name === 'AbortError') return 'Request cancelled.';
  return err.message ? `Unexpected error: ${err.message}` : 'Something went wrong.';
}

/** Installs window-level handlers; `report` receives a user-facing message. */
export function installErrorBoundary(report) {
  window.addEventListener('error', (e) => {
    // Resource load errors (img/audio) have no `error` object — log only.
    if (!e.error) { log.warn('resource error', e.message || e.type); return; }
    log.error('uncaught', e.error);
    report(toUserMessage(e.error));
  });
  window.addEventListener('unhandledrejection', (e) => {
    log.error('unhandled rejection', e.reason);
    report(toUserMessage(e.reason));
  });
}
