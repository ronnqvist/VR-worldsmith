/**
 * In-VR virtual keyboard — the guaranteed input path when SpeechRecognition is
 * unavailable (typical on Meta Quest Browser). A single canvas panel with
 * ray-interactive keys and a large Send button. Also used to edit settings
 * fields (API key, model id) and to name saved worlds.
 */
import { THEME, roundRect, wrapText, placeInFront } from '../ui/canvasPanel.js';

const ROWS_ALPHA = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
  ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '-', '⌫']
];
const ROWS_SYM = [
  ['!', '@', '#', '$', '%', '&', '*', '(', ')', '_'],
  ['+', '=', '/', '\\', ':', ';', '"', '?', '<', '>'],
  ['[', ']', '{', '}', '|', '~', '^', '`', '°', "'"],
  ['⇧', '€', '£', '¥', '§', '±', '×', '÷', '-', '⌫']
];
const MAX_LEN = 1000;

/**
 * @param {{el:HTMLElement}} p  entity carrying ws-canvas-panel (world space)
 */
export function createVRKeyboard({ el }) {
  let target = null;
  let text = '';
  let shift = false;
  let caps = false;
  let symbols = false;
  let open = false;
  const panel = () => el.components['ws-canvas-panel'];

  function maskedText() {
    if (!target?.masked) return text;
    if (text.length <= 8) return '•'.repeat(text.length);
    return `${text.slice(0, 6)}${'•'.repeat(Math.min(20, text.length - 10))}${text.slice(-4)}`;
  }

  function press(id) {
    if (id === 'close') { cancel(); return; }
    if (id === 'send') { submit(); return; }
    if (id === 'shift') { if (shift) { caps = !caps; shift = false; } else shift = true; panel().invalidate(); return; }
    if (id === 'sym') { symbols = !symbols; panel().invalidate(); return; }
    if (id === 'bksp') { text = text.slice(0, -1); panel().invalidate(); return; }
    if (id === 'clear') { text = ''; panel().invalidate(); return; }
    if (id === 'space') { insert(' '); return; }
    if (id === 'paste') {
      navigator.clipboard?.readText?.().then((t) => insert(String(t || '').trim())).catch(() => {
        target && (target.status = 'Clipboard not available here.');
        panel().invalidate();
      });
      return;
    }
    if (id.startsWith('k:')) {
      let ch = id.slice(2);
      if (!symbols && (shift || caps)) ch = ch.toUpperCase();
      insert(ch);
      if (shift) { shift = false; panel().invalidate(); }
    }
  }

  function insert(s) {
    if (!s) return;
    text = (text + s).slice(0, MAX_LEN);
    if (target) target.status = '';
    panel().invalidate();
  }

  function submit() {
    const t = target;
    const value = text.trim();
    if (!t) return;
    if (!value && !t.allowEmpty) { t.status = 'Type something first.'; panel().invalidate(); return; }
    close();
    t.onSubmit?.(value);
  }

  function cancel() {
    const t = target;
    close();
    t?.onCancel?.();
  }

  function render(ctx, api) {
    const { w, h } = api;
    api.background({ radius: 28 });
    const pad = 28;
    // Title + close
    api.text(target?.title || 'Type your prompt', pad, 22, { size: 34, weight: 600, color: THEME.accent, maxWidth: w - 260 });
    api.button('close', w - pad - 120, 16, 120, 56, 'Close', { fontSize: 26 });

    // Text field
    const fy = 86;
    const fh = 150;
    roundRect(ctx, pad, fy, w - pad * 2, fh, 18);
    ctx.fillStyle = '#060912';
    ctx.fill();
    ctx.strokeStyle = THEME.panelBorder;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `400 36px ${THEME.font}`;
    const shown = maskedText();
    if (shown) {
      const lines = wrapText(ctx, `${shown}▏`, w - pad * 2 - 40, 3);
      ctx.fillStyle = THEME.text;
      ctx.textBaseline = 'top';
      lines.slice(-3).forEach((l, i) => ctx.fillText(l, pad + 20, fy + 14 + i * 44));
    } else {
      ctx.fillStyle = THEME.dim;
      ctx.textBaseline = 'top';
      ctx.fillText(target?.placeholder || 'Describe your world…', pad + 20, fy + 14);
    }
    if (target?.status) api.text(target.status, pad, fy + fh + 6, { size: 24, color: THEME.error });

    // Keys
    const rows = symbols ? ROWS_SYM : ROWS_ALPHA;
    const top = fy + fh + 40;
    const gap = 10;
    const kh = 86;
    const kw = (w - pad * 2 - gap * 9) / 10;
    rows.forEach((row, r) => {
      row.forEach((key, c) => {
        const x = pad + c * (kw + gap);
        const y = top + r * (kh + gap);
        if (key === '⇧') {
          api.button('shift', x, y, kw, kh, caps ? '⇪' : '⇧', { variant: shift || caps ? 'on' : undefined });
        } else if (key === '⌫') {
          api.button('bksp', x, y, kw, kh, '⌫');
        } else {
          const label = !symbols && (shift || caps) ? key.toUpperCase() : key;
          api.button(`k:${key}`, x, y, kw, kh, label, { fontSize: 38 });
        }
      });
    });
    // Bottom row
    const by = top + 4 * (kh + gap);
    let x = pad;
    const bw = (n) => kw * n + gap * (n - 1);
    api.button('sym', x, by, bw(1.5), kh, symbols ? 'ABC' : '?123', { fontSize: 30 }); x += bw(1.5) + gap;
    api.button('paste', x, by, bw(1.2), kh, 'Paste', { fontSize: 28 }); x += bw(1.2) + gap;
    api.button('k:,', x, by, bw(0.8), kh, ','); x += bw(0.8) + gap;
    api.button('space', x, by, bw(3), kh, 'space', { fontSize: 30 }); x += bw(3) + gap;
    api.button('k:.', x, by, bw(0.8), kh, '.'); x += bw(0.8) + gap;
    api.button('clear', x, by, bw(1.2), kh, 'Clear', { fontSize: 28 }); x += bw(1.2) + gap;
    api.button('send', x, by, w - pad - x, kh, target?.submitLabel || 'Send ➤', { variant: 'accent', fontSize: 38 });
    void h;
  }

  function onPhysicalKey(e) {
    if (!open) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') cancel();
    else if (e.key === 'Backspace') { e.preventDefault(); press('bksp'); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); insert(e.key); }
  }

  function configure() {
    panel().configure({ width: 1.1, height: 0.62, pxPerMeter: 1400, render, onPress: press });
  }

  /** target: {title, value, masked, placeholder, submitLabel, allowEmpty, onSubmit(text), onCancel()} */
  function openKeyboard(t) {
    if (!panel()) return;
    configure();
    target = { ...t, status: '' };
    text = String(t.value || '');
    shift = false;
    symbols = false;
    open = true;
    placeInFront(el, { distance: 0.75, yOffset: -0.38, tilt: 0.4 });
    panel().show(true);
    window.addEventListener('keydown', onPhysicalKey, true);
  }

  function close() {
    open = false;
    target = null;
    panel()?.show(false);
    window.removeEventListener('keydown', onPhysicalKey, true);
  }

  return { open: openKeyboard, close, cancel, isOpen: () => open };
}
