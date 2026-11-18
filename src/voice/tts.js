/**
 * Narration via speechSynthesis (when available and not muted). Callers always
 * show the caption too; this module only handles the audio + timing.
 */
export function createTTS({ isMuted }) {
  const synth = globalThis.speechSynthesis;
  const available = !!synth && typeof globalThis.SpeechSynthesisUtterance === 'function';
  let voice = null;

  function pickVoice() {
    if (!available) return null;
    const voices = synth.getVoices();
    const lang = (navigator.language || 'en').slice(0, 2);
    return voices.find((v) => v.lang?.startsWith(lang) && /natural|neural|google|samantha|daniel/i.test(v.name))
      || voices.find((v) => v.lang?.startsWith(lang)) || voices[0] || null;
  }
  if (available) {
    voice = pickVoice();
    synth.addEventListener?.('voiceschanged', () => { voice = pickVoice(); });
  }

  /**
   * Speaks text. Resolves when finished (or immediately-ish when muted/unavailable,
   * after a reading-time delay so the "speaking" state is still visible).
   */
  function speak(text, { onStart } = {}) {
    return new Promise((resolve) => {
      const readMs = Math.min(9000, 1200 + String(text).length * 55);
      if (!available || isMuted() || !text) {
        onStart?.({ spoken: false });
        setTimeout(resolve, Math.min(readMs, 2500));
        return;
      }
      try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        if (voice) u.voice = voice;
        u.rate = 1.0;
        u.pitch = 1.0;
        let done = false;
        const end = () => { if (!done) { done = true; resolve(); } };
        u.onend = end;
        u.onerror = end;
        onStart?.({ spoken: true });
        synth.speak(u);
        setTimeout(end, readMs + 4000); // engines occasionally never fire onend
      } catch {
        onStart?.({ spoken: false });
        setTimeout(resolve, 1500);
      }
    });
  }

  function cancel() { try { synth?.cancel(); } catch { /* ignore */ } }

  return { speak, cancel, available };
}
