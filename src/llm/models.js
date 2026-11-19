/**
 * Model capabilities + reasoning-effort resolution. Pure (no DOM / A-Frame).
 *
 * Reasoning levels differ per model, so nothing here assumes a fixed list:
 *   • presets/STT models have verified capabilities below (OpenRouter catalogue, 2026-11-19)
 *   • any other model id is looked up in a cached slim copy of the live catalogue
 *     (GET https://openrouter.ai/api/v1/models), loaded lazily by the app
 *   • unknown models fall back to sending the user's level as-is (OpenRouter maps it)
 *
 * OpenRouter's `reasoning` parameter: { effort: none|minimal|low|medium|high|xhigh|max }
 * or { max_tokens: n }, plus { exclude: true } to not return the reasoning text.
 * For budget-based providers (Anthropic, Gemini 2.5, Qwen) the thinking budget is a
 * share of the request's max_tokens, which is why max_tokens is scaled up here so
 * the visible JSON keeps its own budget.
 */
import { OPENROUTER_BASE } from '../core/config.js';

export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_SETTINGS = ['auto', 'provider', ...EFFORT_ORDER];
export const EFFORT_LABEL = {
  auto: 'Auto', provider: 'Provider default', none: 'None (off)', minimal: 'Minimal', low: 'Low',
  medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max'
};
/** Share of max_tokens OpenRouter reserves for thinking on budget-based providers. */
export const EFFORT_BUDGET_RATIO = { none: 0, minimal: 0.1, low: 0.2, medium: 0.5, high: 0.8, xhigh: 0.95, max: 0.95 };
const ABSOLUTE_MAX_TOKENS = 128000;
const DEFAULT_MAX_OUTPUT = 64000;
/** Providers whose thinking budget is derived from max_tokens (see OpenRouter reasoning docs). */
const BUDGET_PROVIDER_PREFIXES = ['anthropic/', 'google/gemini-2', 'qwen/'];

/**
 * Verified capabilities. efforts are ascending; `recommended` is what "Auto" sends.
 * mandatory = reasoning cannot be switched off.
 */
export const KNOWN_CAPS = Object.freeze({
  'anthropic/claude-sonnet-5.5': { reasoning: true, mandatory: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', recommended: 'medium', maxOutput: 128000 },
  'x-ai/grok-4.7': { reasoning: true, mandatory: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', recommended: 'medium', maxOutput: 450000 },
  'google/gemini-3.1-flash-lite': { reasoning: true, mandatory: false, efforts: ['none', 'minimal', 'low', 'medium', 'high'], defaultEffort: 'minimal', recommended: 'none', maxOutput: 65536 },
  'google/gemini-3.5-flash-lite': { reasoning: true, mandatory: true, efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'minimal', recommended: 'minimal', maxOutput: 65536 },
  'google/gemini-2.5-flash-lite': { reasoning: true, mandatory: false, efforts: [], defaultEffort: null, recommended: null, maxOutput: 65535 },
  'mistralai/voxtral-small-24b-2507': { reasoning: false, mandatory: false, efforts: [], defaultEffort: null, recommended: null, maxOutput: 26214 },
  'openai/gpt-audio-mini': { reasoning: false, mandatory: false, efforts: [], defaultEffort: null, recommended: null, maxOutput: 16384 }
});

let catalogue = new Map(); // id → caps, from the live catalogue

/** Converts one OpenRouter catalogue entry to our caps shape. */
export function capsFromCatalogue(m) {
  const params = m?.supported_parameters || [];
  const r = m?.reasoning;
  const hasReasoning = !!r || params.includes('reasoning') || params.includes('reasoning_effort');
  let efforts = [];
  if (r && Array.isArray(r.supported_efforts)) {
    efforts = EFFORT_ORDER.filter((e) => r.supported_efforts.includes(e));
  } else if (r && r.supported_efforts === null) {
    efforts = [...EFFORT_ORDER]; // null = every level accepted
  } else if (hasReasoning && !r) {
    efforts = [...EFFORT_ORDER]; // legacy entry without details: let OpenRouter map it
  }
  return {
    reasoning: hasReasoning,
    mandatory: !!r?.mandatory,
    efforts,
    defaultEffort: r?.default_effort || null,
    recommended: null,
    maxOutput: m?.top_provider?.max_completion_tokens || null
  };
}

/** Replaces the catalogue cache from a slim {id: caps} object (e.g. restored from storage). */
export function setCatalogue(obj) {
  catalogue = new Map(Object.entries(obj || {}));
}

/** Fetches the live catalogue and returns a slim {id: caps} object (also installed in memory). */
export async function fetchCatalogue({ fetchImpl = globalThis.fetch, signal } = {}) {
  const res = await fetchImpl(`${OPENROUTER_BASE}/models`, { signal, credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`catalogue HTTP ${res.status}`);
  const data = await res.json();
  const slim = {};
  for (const m of data?.data || []) {
    if (typeof m?.id === 'string') slim[m.id] = capsFromCatalogue(m);
  }
  setCatalogue(slim);
  return slim;
}

/** Capabilities for a model id, or null when unknown. */
export function getCaps(id) {
  return KNOWN_CAPS[id] || catalogue.get(id) || null;
}

function nearestEffort(target, efforts, mandatory) {
  if (!efforts.length) return null;
  if (efforts.includes(target)) return target;
  if (target === 'none') return mandatory ? efforts.find((e) => e !== 'none') || efforts[0] : efforts[0];
  const ti = EFFORT_ORDER.indexOf(target);
  let best = efforts[0];
  let bestDist = Infinity;
  for (const e of efforts) {
    const d = Math.abs(EFFORT_ORDER.indexOf(e) - ti);
    // On a tie prefer the lower (faster) level.
    if (d < bestDist || (d === bestDist && EFFORT_ORDER.indexOf(e) < EFFORT_ORDER.indexOf(best))) { best = e; bestDist = d; }
  }
  return best;
}

/**
 * Effort actually sent for a model + setting. Returns null when the parameter
 * should be omitted (Provider default, or a model without reasoning).
 */
export function resolveEffort(id, setting = 'auto') {
  if (setting === 'provider') return null;
  const caps = getCaps(id);
  if (caps && !caps.reasoning) return null;
  const target = setting === 'auto' ? (caps?.recommended || 'low') : setting;
  if (!EFFORT_ORDER.includes(target)) return null;
  if (!caps) return target; // unknown model: let OpenRouter map it
  if (!caps.efforts.length) return null; // reasoning without effort control
  return nearestEffort(target, caps.efforts, caps.mandatory);
}

/** Lowest reasoning a model allows (used for transcription). */
export function lowestEffort(id) {
  const caps = getCaps(id);
  if (!caps || !caps.reasoning || !caps.efforts.length) return caps ? null : 'none';
  return caps.mandatory ? caps.efforts.find((e) => e !== 'none') || caps.efforts[0] : caps.efforts[0];
}

/**
 * Options for the per-model dropdown.
 * @returns {{known:boolean, reasoning:boolean, levels:string[], defaultEffort:string|null, recommended:string}}
 */
export function effortOptions(id) {
  const caps = getCaps(id);
  if (!caps) return { known: false, reasoning: true, levels: [...EFFORT_ORDER], defaultEffort: null, recommended: 'low' };
  return {
    known: true,
    reasoning: caps.reasoning && caps.efforts.length > 0,
    levels: caps.reasoning ? caps.efforts : [],
    defaultEffort: caps.defaultEffort,
    recommended: resolveEffort(id, 'auto')
  };
}

/**
 * Builds the reasoning part of a request.
 * @returns {{reasoning: object|undefined, maxTokens:number, effort:string|null}}
 */
export function planReasoning(id, setting, visibleTokens) {
  const caps = getCaps(id);
  const effort = resolveEffort(id, setting);
  const cap = Math.min(caps?.maxOutput || DEFAULT_MAX_OUTPUT, ABSOLUTE_MAX_TOKENS);
  if (!effort) return { reasoning: undefined, maxTokens: Math.min(visibleTokens, cap), effort: null };
  if (effort === 'none') return { reasoning: { effort: 'none' }, maxTokens: Math.min(visibleTokens, cap), effort };
  const ratio = EFFORT_BUDGET_RATIO[effort] ?? 0.5;
  const wanted = Math.round(visibleTokens / (1 - ratio));
  const budgetStyle = BUDGET_PROVIDER_PREFIXES.some((p) => id.startsWith(p));
  if (budgetStyle && wanted > cap) {
    // The share-based budget would starve the visible output: give an explicit thinking budget instead.
    const budget = Math.max(1024, cap - visibleTokens);
    return { reasoning: { max_tokens: budget, exclude: true }, maxTokens: cap, effort };
  }
  let maxTokens = Math.min(wanted, cap);
  // Budget providers enforce a 1024-token thinking minimum that must still leave room for the answer.
  if (budgetStyle && ratio * maxTokens < 1024) maxTokens = Math.min(visibleTokens + 1024, cap);
  return { reasoning: { effort, exclude: true }, maxTokens, effort };
}
