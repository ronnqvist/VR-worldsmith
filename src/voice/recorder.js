/**
 * Microphone recorder → 16 kHz mono WAV (base64), for engines that transcribe
 * audio themselves (OpenRouter audio models). Used where the Web Speech API is
 * missing — notably Meta Quest Browser.
 *
 * Capture uses ScriptProcessorNode rather than AudioWorklet: a worklet module
 * would have to be loaded from a blob/URL, which the production CSP does not
 * allow for scripts, and the deprecated node is fine for short voice clips.
 */
import { encodeWav } from '../audio/ambient.js';

export const TARGET_RATE = 16000;
export const MAX_SECONDS = 30;
export const MIN_SECONDS = 0.4;

/** Linear-interpolating resampler (voice band only, so no anti-alias filter needed beyond the mic's). */
export function downsample(input, inRate, outRate = TARGET_RATE) {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = pos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

/** ArrayBuffer → base64 (chunked so large clips don't overflow the call stack). */
export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function micError(err) {
  const name = err?.name || '';
  let message = `Microphone error: ${err?.message || name || 'unknown'}`;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    message = 'Microphone permission denied. Allow it in the browser’s site settings, then try again.';
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    message = 'No microphone found.';
  } else if (name === 'NotReadableError') {
    message = 'The microphone is busy in another app.';
  }
  const e = new Error(message);
  e.userMessage = message;
  e.code = 'mic';
  e.cause = err;
  return e;
}

export function isRecordingSupported() {
  return !!(globalThis.navigator?.mediaDevices?.getUserMedia && (globalThis.AudioContext || globalThis.webkitAudioContext));
}

/**
 * Starts recording. Resolves to a handle once the mic is live:
 *   handle.stop()  → Promise<{wavBase64, seconds} | null>  (null when too short)
 *   handle.abort() → discards the clip
 * `onLevel(rms)` is called ~10×/s; `onAutoStop()` fires when MAX_SECONDS is reached.
 */
export async function startRecording({ onLevel, onAutoStop } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    throw micError(err);
  }
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the graph pulling without echoing the mic to the speakers
  const chunks = [];
  let samples = 0;
  let lastLevel = 0;
  let finished = false;
  const maxSamples = ctx.sampleRate * MAX_SECONDS;

  proc.onaudioprocess = (e) => {
    if (finished) return;
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    samples += data.length;
    const now = performance.now();
    if (onLevel && now - lastLevel > 100) {
      lastLevel = now;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i];
      onLevel(Math.sqrt(sum / (data.length / 4)));
    }
    if (samples >= maxSamples) onAutoStop?.();
  };
  source.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  function teardown() {
    finished = true;
    try { source.disconnect(); proc.disconnect(); mute.disconnect(); } catch { /* ignore */ }
    for (const t of stream.getTracks()) t.stop(); // turns the headset mic indicator off
    ctx.close().catch(() => {});
  }

  return {
    sampleRate: ctx.sampleRate,
    async stop() {
      if (finished) return null;
      const rate = ctx.sampleRate;
      teardown();
      const seconds = samples / rate;
      if (seconds < MIN_SECONDS) return null;
      const all = new Float32Array(samples);
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.length; }
      const pcm = downsample(all, rate, TARGET_RATE);
      return { wavBase64: toBase64(encodeWav(pcm, TARGET_RATE)), seconds };
    },
    abort() { if (!finished) teardown(); }
  };
}
