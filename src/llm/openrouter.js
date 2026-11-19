/**
 * OpenRouter client (OpenAI-compatible chat completions). Plain fetch, no SDK.
 * The API key is sent ONLY to openrouter.ai, in the Authorization header.
 * No DOM / A-Frame / Three.js here.
 */
import { OPENROUTER_BASE } from '../core/config.js';
import { UserFacingError } from '../core/errors.js';
import { createLogger } from '../core/log.js';
import { planReasoning, lowestEffort, effortOptions, EFFORT_LABEL } from './models.js';

const log = createLogger('openrouter');
const TIMEOUT_MS = 120_000;

export function looksLikeKey(key) {
  return typeof key === 'string' && /^sk-or-[A-Za-z0-9_-]{10,}$/.test(key.trim());
}

/** Header values must be ISO-8859-1; strip anything else so fetch() never throws. */
function headerSafe(v) {
  return String(v || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 200);
}

function buildHeaders({ apiKey, referer, title }) {
  const h = {
    Authorization: `Bearer ${String(apiKey || '').trim()}`,
    'Content-Type': 'application/json'
  };
  const r = headerSafe(referer);
  const t = headerSafe(title);
  if (r) h['HTTP-Referer'] = r;
  if (t) h['X-Title'] = t;
  return h;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

/** Maps an HTTP status (+ OpenRouter error body) to a short user-facing error. */
export function mapHttpError(status, body) {
  const msg = body?.error?.message || body?.message || '';
  const detail = String(msg).slice(0, 200);
  switch (status) {
    case 400: return new UserFacingError(`OpenRouter rejected the request: ${detail || 'bad request'}.`, { code: 'bad_request', detail });
    case 401: return new UserFacingError('OpenRouter rejected your key. Check it in Settings.', { code: 'auth', detail });
    case 402: return new UserFacingError('Your OpenRouter account is out of credits.', { code: 'credits', detail });
    case 403: return new UserFacingError(`OpenRouter refused this request${detail ? `: ${detail}` : ' (moderation or key restrictions)'}.`, { code: 'forbidden', detail });
    case 404: return new UserFacingError('That model was not found on OpenRouter. Check the model id in Settings.', { code: 'model', detail });
    case 408: return new UserFacingError('The model took too long to answer. Try again.', { code: 'timeout', detail });
    case 413: return new UserFacingError('The world is too large to send. Try Reset or a smaller world.', { code: 'too_large', detail });
    case 429: return new UserFacingError('OpenRouter is rate-limiting you. Wait a moment and try again.', { code: 'rate', detail });
    case 502: case 503: return new UserFacingError('The model provider is unavailable right now. Try again or switch models.', { code: 'upstream', detail });
    default: return new UserFacingError(`OpenRouter error ${status}${detail ? `: ${detail}` : ''}.`, { code: 'http', detail });
  }
}

const retryable = (status) => status === 429 || (status >= 500 && status <= 599);

/**
 * Low-level request with timeout + ONE retry on 429/5xx/network errors
 * (exponential backoff with jitter, honouring Retry-After up to 8 s).
 */
async function request(path, { method = 'POST', headers, body, signal, fetchImpl = globalThis.fetch }) {
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), TIMEOUT_MS);
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetchImpl(`${OPENROUTER_BASE}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
        credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin', cache: 'no-store'
      });
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const timedOut = ctrl.signal.reason?.name === 'TimeoutError';
      if (attempt === 0 && !timedOut) {
        attempt++;
        log.warn('network error, retrying once', err);
        await sleep(1000 + Math.random() * 400, signal);
        continue;
      }
      throw new UserFacingError(timedOut
        ? 'The model took too long to answer. Try again.'
        : 'Could not reach OpenRouter. Check your connection.', { code: timedOut ? 'timeout' : 'network', cause: err });
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);

    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!res.ok) {
      if (attempt === 0 && retryable(res.status)) {
        attempt++;
        const ra = Number.parseFloat(res.headers.get('retry-after') || '');
        const wait = Number.isFinite(ra) ? Math.min(ra * 1000, 8000) : 1000 * 2 ** attempt + Math.random() * 500;
        log.warn(`HTTP ${res.status}, retrying in ${Math.round(wait)} ms`);
        await sleep(wait, signal);
        continue;
      }
      throw mapHttpError(res.status, data);
    }
    return data;
  }
}

const REASONING_REJECTED = /reasoning|effort|thinking|budget/i;
const JSON_MODE_REJECTED = /response_format|json_object|json mode/i;

/**
 * Sends a chat completion that must return a JSON object.
 * `reasoningEffort` is the user's setting ('auto' | 'provider' | none … max); it is
 * resolved per model (see models.js), and max_tokens is scaled so thinking doesn't
 * eat the visible output.
 * @returns {Promise<{content:string, usage:object|null, model:string, finishReason:string|null, effort:string|null, notes:string[]}>}
 */
export async function chatJSON({
  apiKey, model, messages, referer, title, temperature = 0.7, maxTokens = 12000, reasoningEffort = 'auto', signal, fetchImpl
}) {
  if (!apiKey) throw new UserFacingError('Add your OpenRouter API key in Settings first.', { code: 'no_key' });
  if (!model) throw new UserFacingError('Choose a model in Settings first.', { code: 'no_model' });
  const headers = buildHeaders({ apiKey, referer, title });
  const plan = planReasoning(model, reasoningEffort, maxTokens);
  const body = {
    model,
    messages,
    response_format: { type: 'json_object' },
    temperature,
    max_tokens: plan.maxTokens,
    stream: false,
    // Fastest healthy host first: the user is waiting in VR.
    provider: { sort: 'throughput' }
  };
  if (plan.reasoning) body.reasoning = plan.reasoning;
  let effort = plan.effort;
  const notes = [];
  let lowered = false;
  const started = performance.now();
  for (;;) {
    let data;
    try {
      data = await request('/chat/completions', { headers, body, signal, fetchImpl });
    } catch (err) {
      // Some providers reject response_format or the reasoning parameter: retry once without each.
      if (err.code === 'bad_request' && body.response_format && JSON_MODE_REJECTED.test(err.detail || '')) {
        log.warn('model rejected response_format, retrying without it');
        delete body.response_format;
        continue;
      }
      if (err.code === 'bad_request' && body.reasoning && REASONING_REJECTED.test(err.detail || '')) {
        log.warn('model rejected the reasoning parameter, retrying without it');
        delete body.reasoning;
        body.max_tokens = maxTokens;
        effort = null;
        notes.push('This model rejected the reasoning setting; sent without it.');
        continue;
      }
      throw err;
    }
    // OpenRouter can return 200 with an `error` object (provider failure mid-stream).
    if (data?.error) throw mapHttpError(Number(data.error.code) || 502, data);
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason || choice?.native_finish_reason || null;
    const empty = typeof content !== 'string' || !content.trim();
    log.info(`completion in ${Math.round(performance.now() - started)} ms`, { model: data?.model, usage: data?.usage, finishReason, effort });
    if (finishReason === 'length' && empty && body.reasoning && !lowered) {
      // Thinking used the whole budget before any JSON: retry once at the lowest level.
      const low = lowestEffort(model);
      lowered = true;
      if (low && low !== effort) {
        log.warn(`reasoning at "${effort}" used the whole output budget; retrying at "${low}"`);
        const p2 = planReasoning(model, low, maxTokens);
        if (p2.reasoning) body.reasoning = p2.reasoning; else delete body.reasoning;
        body.max_tokens = p2.maxTokens;
        notes.push(`Reasoning at "${effort}" used the whole output budget; retried at "${low}".`);
        effort = low;
        continue;
      }
    }
    if (finishReason === 'length') {
      throw new UserFacingError(effort && effort !== 'none' && effort !== 'low'
        ? `The model ran out of output tokens (reasoning: ${effort}). Try a lower reasoning effort or raise Max tokens.`
        : 'The model ran out of output tokens mid-world. Try a simpler request or raise Max tokens.', { code: 'length' });
    }
    if (empty) {
      throw new UserFacingError('The model returned an empty reply. Try again or pick another model.', { code: 'empty' });
    }
    return { content, usage: data.usage || null, model: data.model || model, finishReason, effort, notes };
  }
}

/**
 * "Validate key": GET /key (free, checks the key itself and reports credit),
 * then a 1-token-ish completion against the selected model.
 * @returns {Promise<{ok:boolean, key:{label?:string, limitRemaining?:number|null, usage?:number}|null, model:{ok:boolean, message:string}}>}
 */
export async function validateKey({ apiKey, model, referer, title, reasoningEffort = 'auto', signal, fetchImpl }) {
  if (!apiKey) throw new UserFacingError('Enter an API key first.', { code: 'no_key' });
  const headers = buildHeaders({ apiKey, referer, title });
  const info = await request('/key', { method: 'GET', headers, signal, fetchImpl });
  const d = info?.data || {};
  const key = { label: d.label, limitRemaining: d.limit_remaining ?? null, usage: d.usage, isFreeTier: d.is_free_tier };
  let modelResult = { ok: false, message: 'not tested' };
  if (model) {
    try {
      // Ping at the model's lowest reasoning level (cheap); report what the real setting resolves to.
      const opts = effortOptions(model);
      const ping = await chatJSON({
        apiKey, model, referer, title, signal, fetchImpl, maxTokens: 64, temperature: 0,
        reasoningEffort: lowestEffort(model) || 'provider',
        messages: [
          { role: 'system', content: 'Reply with the JSON object {"ok":true} and nothing else.' },
          { role: 'user', content: 'ping' }
        ]
      });
      void ping;
      const effective = planReasoning(model, reasoningEffort, 12000).effort;
      const levels = opts.known ? (opts.levels.length ? opts.levels.map((l) => EFFORT_LABEL[l].toLowerCase()).join(', ') : 'none') : 'unknown';
      modelResult = {
        ok: true,
        message: `Model "${model}" answered. Reasoning levels: ${levels}; your setting sends: ${effective || 'provider default'}.`
      };
    } catch (err) {
      // A 'length' finish still proves the model is reachable.
      if (err.code === 'length') modelResult = { ok: true, message: `Model "${model}" answered.` };
      else modelResult = { ok: false, message: err.userMessage || err.message };
    }
  }
  return { ok: true, key, model: modelResult };
}

const TRANSCRIBE_SYSTEM = 'You are a speech-to-text engine. Return ONLY the verbatim transcript of what the speaker says, '
  + 'in the language spoken, with normal punctuation. No quotes, labels, translations or commentary. '
  + 'If there is no intelligible speech, return an empty string.';

/** Removes wrappers models sometimes add around a transcript. */
export function cleanTranscript(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
  t = t.replace(/^(transcript(ion)?|text)\s*:\s*/i, '').trim();
  t = t.replace(/^["“”'«»]+|["“”'«»]+$/g, '').trim();
  if (/^(\(|\[)?\s*(no (intelligible )?speech|silence|inaudible|empty)\s*(\)|\])?\.?$/i.test(t)) return '';
  return t.slice(0, 2000);
}

/**
 * Speech-to-text through an audio-capable OpenRouter model: the clip goes in an
 * `input_audio` content part (base64 WAV). Used where the browser has no
 * SpeechRecognition (Meta Quest Browser).
 * @returns {Promise<string>} transcript ('' when no speech)
 */
export async function transcribeAudio({ apiKey, model, wavBase64, referer, title, signal, fetchImpl }) {
  if (!apiKey) throw new UserFacingError('Voice input needs your OpenRouter API key (Settings).', { code: 'no_key' });
  if (!model) throw new UserFacingError('Choose a transcription model in Settings.', { code: 'no_model' });
  const headers = buildHeaders({ apiKey, referer, title });
  const body = {
    model,
    temperature: 0,
    max_tokens: 600,
    stream: false,
    messages: [
      { role: 'system', content: TRANSCRIBE_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this recording.' },
          { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } }
        ]
      }
    ]
  };
  // Transcription needs no thinking: send the model's lowest level.
  const low = lowestEffort(model);
  if (low === 'none') body.reasoning = { effort: 'none' };
  else if (low) body.reasoning = { effort: low, exclude: true };
  const started = performance.now();
  let data;
  try {
    try {
      data = await request('/chat/completions', { headers, body, signal, fetchImpl });
    } catch (err) {
      if (!(err.code === 'bad_request' && body.reasoning && REASONING_REJECTED.test(err.detail || ''))) throw err;
      delete body.reasoning;
      data = await request('/chat/completions', { headers, body, signal, fetchImpl });
    }
  } catch (err) {
    if (err.code === 'bad_request' || err.code === 'model') {
      throw new UserFacingError(`The transcription model "${model}" could not process audio. Pick an audio-capable model in Settings.`, { code: 'stt_model', cause: err, detail: err.detail });
    }
    throw err;
  }
  if (data?.error) throw mapHttpError(Number(data.error.code) || 502, data);
  const content = data?.choices?.[0]?.message?.content;
  const text = cleanTranscript(typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p.text || '').join(' ') : '');
  log.info(`transcribed in ${Math.round(performance.now() - started)} ms`, { model: data?.model, chars: text.length });
  return text;
}
