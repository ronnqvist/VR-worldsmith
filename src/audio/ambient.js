/**
 * Procedural ambient loop, rendered once at startup with an OfflineAudioContext
 * (no network, no user gesture needed) and exposed as a WAV blob URL. main.js
 * assigns it to <audio id="generated-ambient"> inside <a-assets>, the ONLY
 * audio source the sanitizer lets LLM markup reference.
 *
 * Sound design: a soft A-major pad (detuned sine/triangle pairs through a
 * low-pass) with slow tremolo, plus band-passed "wind" noise. The tail of the
 * render is equal-power crossfaded into the head so the loop is seamless.
 */

const SAMPLE_RATE = 22050;  // plenty for a low-passed pad, keeps the blob ~350 KB
const LOOP_SECONDS = 8;
const XFADE_SECONDS = 1.5;

export async function generateAmbientLoop() {
  const total = LOOP_SECONDS + XFADE_SECONDS;
  let rendered;
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (OAC) {
    try {
      rendered = await renderWithWebAudio(new OAC(1, Math.ceil(SAMPLE_RATE * total), SAMPLE_RATE));
    } catch {
      rendered = null;
    }
  }
  if (!rendered) rendered = renderFallback(total);
  const loop = crossfadeLoop(rendered, SAMPLE_RATE, LOOP_SECONDS, XFADE_SECONDS);
  normalize(loop, 0.7);
  const wav = encodeWav(loop, SAMPLE_RATE);
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
}

async function renderWithWebAudio(ctx) {
  const master = ctx.createGain();
  master.gain.value = 0.22;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 950;
  lowpass.Q.value = 0.4;
  lowpass.connect(master);
  master.connect(ctx.destination);

  // A2, E3, A3, C#4, E4 — open, calm voicing.
  const notes = [110, 164.81, 220, 277.18, 329.63];
  notes.forEach((freq, i) => {
    const voiceGain = ctx.createGain();
    voiceGain.gain.value = 0.5 / (1 + i * 0.35);
    // Slow tremolo, each voice at a different rate so the texture breathes.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07 + i * 0.031;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.18;
    lfo.connect(lfoDepth).connect(voiceGain.gain);
    lfo.start(0);
    for (const [type, cents] of [['sine', -4], ['triangle', 5]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = cents;
      osc.connect(voiceGain);
      osc.start(0);
    }
    voiceGain.connect(lowpass);
  });

  // Wind: white noise → swept band-pass.
  const noiseBuf = ctx.createBuffer(1, ctx.length, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  let seed = 1234567;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // deterministic LCG
    data[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 500;
  band.Q.value = 0.8;
  const sweep = ctx.createOscillator();
  sweep.frequency.value = 0.09;
  const sweepDepth = ctx.createGain();
  sweepDepth.gain.value = 260;
  sweep.connect(sweepDepth).connect(band.frequency);
  sweep.start(0);
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.11;
  noise.connect(band).connect(noiseGain).connect(master);
  noise.start(0);

  const buf = await ctx.startRendering();
  return buf.getChannelData(0).slice();
}

/** Pure-JS fallback (same character, simpler) for browsers without OfflineAudioContext. */
function renderFallback(seconds) {
  const n = Math.ceil(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  const notes = [110, 164.81, 220, 277.18];
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let s = 0;
    notes.forEach((f, k) => {
      const trem = 0.8 + 0.2 * Math.sin(2 * Math.PI * (0.07 + k * 0.03) * t);
      s += (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.003 * t)) * trem / (1 + k * 0.4);
    });
    out[i] = s * 0.1;
  }
  return out;
}

/** Equal-power crossfade of the render's tail into its head → seamless loop. */
function crossfadeLoop(src, sr, loopSec, xfadeSec) {
  const L = Math.floor(sr * loopSec);
  const X = Math.floor(sr * xfadeSec);
  const out = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    if (i < X) {
      const t = (i / X) * (Math.PI / 2);
      out[i] = src[i] * Math.sin(t) + (src[L + i] || 0) * Math.cos(t);
    } else {
      out[i] = src[i];
    }
  }
  return out;
}

function normalize(buf, peak) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  if (max < 1e-6) return;
  const g = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples, sampleRate) {
  const bytes = 44 + samples.length * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return view.buffer;
}
