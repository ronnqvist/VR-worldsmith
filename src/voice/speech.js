/**
 * Speech input via the Web Speech API, with automatic routing to the VR
 * keyboard when it is missing or broken.
 *
 * Meta Quest Browser exposes `webkitSpeechRecognition` inconsistently: it may
 * be absent, or present but fail with `network` / `not-allowed` /
 * `service-not-allowed`. Such failures are remembered per user-agent so later
 * sessions go straight to the keyboard (the user can force "voice" in settings).
 */
import { createLogger } from '../core/log.js';

const log = createLogger('speech');
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'network', 'audio-capture', 'language-not-supported']);

/**
 * @param {{getStatus:()=>Promise<object>, setStatus:(s:object)=>Promise<void>, getMode:()=>string}} deps
 */
export function createSpeechInput({ getStatus, setStatus, getMode }) {
  const Ctor = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let broken = false;
  let rec = null;
  let listening = false;
  let handlers = null;
  let finalText = '';
  let interimText = '';
  let endTimer = null;

  async function init() {
    if (!Ctor) { log.info('SpeechRecognition not available — keyboard fallback'); return; }
    try {
      const s = await getStatus();
      if (s?.broken && s.ua === navigator.userAgent) {
        broken = true;
        log.info('SpeechRecognition previously failed on this browser — keyboard fallback');
      }
    } catch { /* ignore */ }
  }

  /** True when voice should be attempted given availability + the user's input mode. */
  function shouldUseVoice() {
    const mode = getMode();
    if (mode === 'keyboard' || !Ctor) return false;
    if (mode === 'voice') return true;
    return !broken;
  }

  function markBroken(reason) {
    broken = true;
    setStatus({ broken: true, ua: navigator.userAgent, reason, at: Date.now() }).catch(() => {});
  }

  /**
   * Starts listening. handlers: onInterim(text), onFinal(text), onError({fatal, message}), onEnd()
   */
  function start(h) {
    if (!Ctor) { h.onError?.({ fatal: true, message: 'Voice input is not available in this browser.' }); return false; }
    if (listening) return true;
    handlers = h;
    finalText = '';
    interimText = '';
    try {
      rec = new Ctor();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += `${r[0].transcript} `;
          else interim += r[0].transcript;
        }
        interimText = interim;
        handlers?.onInterim?.(`${finalText}${interim}`.trim());
      };
      rec.onerror = (e) => {
        log.warn('recognition error', e.error);
        if (FATAL.has(e.error)) {
          markBroken(e.error);
          handlers?.onError?.({ fatal: true, message: e.error === 'not-allowed'
            ? 'Microphone permission was denied. Using the keyboard instead.'
            : 'Voice input is not working in this browser. Using the keyboard instead.' });
        } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
          handlers?.onError?.({ fatal: false, message: `Voice input error: ${e.error}` });
        }
      };
      rec.onend = () => finish();
      rec.start();
      listening = true;
      return true;
    } catch (err) {
      log.warn('start failed', err);
      markBroken('start-failed');
      h.onError?.({ fatal: true, message: 'Voice input could not start. Using the keyboard instead.' });
      return false;
    }
  }

  function finish() {
    if (!handlers) return;
    clearTimeout(endTimer);
    const h = handlers;
    handlers = null;
    listening = false;
    rec = null;
    // Some engines only deliver interim text before ending: use it as final.
    const text = (finalText || interimText).trim();
    if (text) h.onFinal?.(text);
    h.onEnd?.();
  }

  /** Stops listening; the final transcript arrives via onFinal shortly after. */
  function stop() {
    if (!rec) return;
    try { rec.stop(); } catch { /* ignore */ }
    // Safety net: some engines never fire onend after stop().
    clearTimeout(endTimer);
    endTimer = setTimeout(finish, 2500);
  }

  function abort() {
    if (!rec) return;
    handlers = null;
    try { rec.abort(); } catch { /* ignore */ }
    listening = false;
    rec = null;
  }

  return {
    init,
    start,
    stop,
    abort,
    shouldUseVoice,
    isListening: () => listening,
    isSupported: () => !!Ctor,
    isBroken: () => broken,
    resetBroken: () => { broken = false; setStatus({}).catch(() => {}); }
  };
}
