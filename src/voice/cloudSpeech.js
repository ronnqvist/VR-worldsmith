/**
 * Cloud speech engine: records the mic (recorder.js) and transcribes the clip
 * with an audio-capable OpenRouter model. Same handler interface as the Web
 * Speech engine in speech.js, plus:
 *   onTranscribing()  recording finished, waiting for the transcript
 *   onLevel(rms)      live mic level while recording
 */
import { startRecording, isRecordingSupported } from './recorder.js';
import { transcribeAudio } from '../llm/openrouter.js';
import { createLogger } from '../core/log.js';

const log = createLogger('cloud-speech');

/**
 * @param {{getConfig:()=>{apiKey:string, model:string, referer:string, title:string}}} deps
 */
export function createCloudSpeech({ getConfig }) {
  let handle = null;      // active recording
  let starting = null;    // pending getUserMedia promise
  let handlers = null;
  let stopRequested = false;
  let abortCtrl = null;
  let busy = false;       // recording or transcribing

  function finish() {
    const h = handlers;
    handlers = null;
    handle = null;
    starting = null;
    busy = false;
    abortCtrl = null;
    h?.onEnd?.();
  }

  async function transcribe(clip, h) {
    if (!clip) {
      h.onError?.({ fatal: false, message: 'Hold the button a bit longer while you speak.' });
      finish();
      return;
    }
    h.onTranscribing?.();
    abortCtrl = new AbortController();
    try {
      const cfg = getConfig();
      const text = await transcribeAudio({ ...cfg, wavBase64: clip.wavBase64, signal: abortCtrl.signal });
      if (!text) h.onError?.({ fatal: false, message: 'I didn’t catch that. Try again.' });
      else h.onFinal?.(text);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        log.warn('transcription failed', err);
        h.onError?.({ fatal: false, message: err.userMessage || `Transcription failed: ${err.message}` });
      }
    } finally {
      finish();
    }
  }

  /** Begins recording. Returns false when it cannot start (handlers.onError is called). */
  function start(h) {
    if (busy) return true;
    if (!isRecordingSupported()) {
      h.onError?.({ fatal: true, message: 'This browser cannot record audio. Using the keyboard instead.' });
      return false;
    }
    if (!getConfig().apiKey) {
      h.onError?.({ fatal: true, message: 'Voice input needs your OpenRouter API key (Settings).' });
      return false;
    }
    handlers = h;
    busy = true;
    stopRequested = false;
    starting = startRecording({
      onLevel: (rms) => handlers?.onLevel?.(rms),
      onAutoStop: () => stop()
    }).then((rec) => {
      handle = rec;
      starting = null;
      // Released before the mic came up (very quick tap): stop right away.
      if (stopRequested) stop();
    }).catch((err) => {
      const hh = handlers;
      hh?.onError?.({ fatal: err.code === 'mic', message: err.userMessage || err.message });
      finish();
    });
    return true;
  }

  function stop() {
    if (!busy) return;
    if (!handle) { stopRequested = true; return; }
    const rec = handle;
    handle = null;
    const h = handlers;
    rec.stop().then((clip) => transcribe(clip, h), (err) => {
      h?.onError?.({ fatal: false, message: err.message });
      finish();
    });
  }

  function abort() {
    handle?.abort();
    abortCtrl?.abort();
    handlers = null;
    handle = null;
    busy = false;
  }

  return {
    start,
    stop,
    abort,
    isSupported: isRecordingSupported,
    isBusy: () => busy
  };
}
