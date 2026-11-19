/**
 * Central constants: budgets, defaults, model list. Pure data — safe to import
 * from any layer (llm, storage, world, ui) and from Node unit tests.
 */

export const APP_NAME = 'Worldsmith';
export const APP_VERSION = '1.0.0';

/** Hard limits enforced by the sanitizer and communicated to the LLM. */
export const LIMITS = Object.freeze({
  maxEntities: 200,        // total elements in #generated-world
  maxCoord: 100,           // |x|,|y|,|z| for position (metres)
  maxScale: 50,            // per-axis scale factor
  maxSize: 100,            // width/height/depth/radius etc. (a-sky exempt)
  maxSkyRadius: 1000,
  maxSegments: 32,         // segments-width / radial / tubular
  maxSegmentsSmall: 24,    // segments-height / phi
  maxDetail: 2,            // polyhedron subdivision detail
  maxLightIntensity: 10,
  maxLights: 8,            // dynamic lights are expensive on XR2 GPUs
  maxTextLength: 280,
  maxMarkupChars: 200_000, // reject absurdly large responses before parsing
  maxNarrationChars: 300,
  maxIdLength: 64,
  minAnimDur: 100,
  maxAnimDur: 120_000
});

/** How much of the current world we send back to the LLM as context. */
export const CONTEXT_BUDGET_CHARS = 24_000;
export const HISTORY_LIMIT = 20;
export const UNDO_LIMIT = 20;
export const CONTEXT_EXCHANGES = 3;

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

/**
 * World-generation presets: only models tested to produce good worlds.
 * Other candidates and their trade-offs are in docs/model-selection.md; any
 * OpenRouter id can still be typed into Settings.
 */
export const MODEL_PRESETS = Object.freeze([
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (default)' },
  { id: 'x-ai/grok-4.7', label: 'Grok 4.7 (newest Grok)' }
]);

/** Former defaults that users never chose explicitly: migrated once (settingsVersion 2). */
export const LEGACY_DEFAULTS = Object.freeze({
  model: ['deepseek/deepseek-v4-flash'],
  sttModel: ['google/gemini-3.5-flash-lite']
});
export const SETTINGS_VERSION = 2;

/** Audio-capable models for speech-to-text when the browser has no SpeechRecognition. */
export const DEFAULT_STT_MODEL = 'google/gemini-3.1-flash-lite';
export const STT_MODEL_PRESETS = Object.freeze([
  { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite (default, most accurate cheap)' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (cheapest)' },
  { id: 'mistralai/voxtral-small-24b-2507', label: 'Voxtral Small (Mistral)' },
  { id: 'openai/gpt-audio-mini', label: 'GPT Audio mini (OpenAI)' }
]);

export const DEFAULT_SETTINGS = Object.freeze({
  model: DEFAULT_MODEL,
  referer: '',            // optional HTTP-Referer header (blank = omit)
  title: 'Worldsmith',    // optional X-Title header (blank = omit)
  temperature: 0.7,
  maxTokens: 12000,
  ttsMuted: false,
  vignette: true,
  smoothSpeed: 2.0,       // m/s
  inputMode: 'auto',      // 'auto' | 'voice' | 'keyboard'
  voiceEngine: 'auto',    // 'auto' | 'browser' (Web Speech) | 'openrouter' (record + transcribe)
  sttModel: DEFAULT_STT_MODEL,
  reasoningEffort: 'auto', // 'auto' | 'provider' | none … max (options shown per model)
  settingsVersion: SETTINGS_VERSION,
  diagnostics: false,
  preferMR: false,
  showStats: false
});

/** Ids used by the app shell. The sanitizer refuses to let LLM markup claim them. */
export const RESERVED_IDS = Object.freeze([
  'generated-world', 'generated-ambient', 'rig', 'camera', 'scene'
]);
export const RESERVED_ID_PREFIX = 'ws-';

export const AMBIENT_ASSET_ID = 'generated-ambient';
