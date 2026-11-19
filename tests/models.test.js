import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffort, planReasoning, effortOptions, lowestEffort, capsFromCatalogue, setCatalogue, fetchCatalogue } from '../src/llm/models.js';
import { chatJSON, transcribeAudio } from '../src/llm/openrouter.js';
import { normalizeSettings } from '../src/storage/store.js';
import { MODEL_PRESETS, DEFAULT_MODEL, DEFAULT_STT_MODEL } from '../src/core/config.js';

const SONNET = 'anthropic/claude-sonnet-5.5';
const GROK = 'x-ai/grok-4.7';

test('presets are exactly Sonnet 5.5 and Grok 4.7, Sonnet default', () => {
  assert.deepEqual(MODEL_PRESETS.map((m) => m.id), [SONNET, GROK]);
  assert.equal(DEFAULT_MODEL, SONNET);
});

test('per-model options differ and exclude none for mandatory reasoning', () => {
  assert.deepEqual(effortOptions(SONNET).levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortOptions(GROK).levels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(effortOptions(SONNET).recommended, 'medium');
  assert.equal(effortOptions('someone/unknown-model').known, false);
});

test('resolveEffort snaps to supported levels', () => {
  assert.equal(resolveEffort(SONNET, 'auto'), 'medium');
  assert.equal(resolveEffort(SONNET, 'none'), 'low');       // mandatory → lowest
  assert.equal(resolveEffort(SONNET, 'minimal'), 'low');
  assert.equal(resolveEffort(GROK, 'max'), 'xhigh');        // Grok tops out at xhigh
  assert.equal(resolveEffort(GROK, 'provider'), null);      // omit parameter
  assert.equal(resolveEffort('openai/gpt-audio-mini', 'high'), null); // no reasoning
  assert.equal(resolveEffort('someone/unknown', 'high'), 'high');     // unknown: pass through
  assert.equal(resolveEffort('someone/unknown', 'auto'), 'low');
});

test('catalogue entries are parsed and used for custom ids', () => {
  setCatalogue({ 'x/custom': capsFromCatalogue({ supported_parameters: ['reasoning'], reasoning: { mandatory: false, supported_efforts: ['high', 'low', 'none'], default_effort: 'high' }, top_provider: { max_completion_tokens: 32000 } }) });
  assert.deepEqual(effortOptions('x/custom').levels, ['none', 'low', 'high']);
  assert.equal(resolveEffort('x/custom', 'medium'), 'low'); // tie → lower level
  assert.equal(resolveEffort('x/custom', 'none'), 'none');
  assert.deepEqual(capsFromCatalogue({ supported_parameters: ['tools'] }).reasoning, false);
  setCatalogue({});
});

test('fetchCatalogue builds a slim map', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ id: 'a/b', supported_parameters: ['reasoning'], reasoning: { supported_efforts: null } }] }));
  const slim = await fetchCatalogue({ fetchImpl });
  assert.equal(slim['a/b'].efforts.length, 7);
  setCatalogue({});
});

test('planReasoning scales max_tokens so the visible JSON keeps its budget', () => {
  assert.deepEqual(planReasoning(SONNET, 'medium', 12000), { reasoning: { effort: 'medium', exclude: true }, maxTokens: 24000, effort: 'medium' });
  assert.equal(planReasoning(GROK, 'high', 12000).maxTokens, 60000);
  // Anthropic xhigh would need 240k: switch to an explicit thinking budget within the 128k cap.
  assert.deepEqual(planReasoning(SONNET, 'xhigh', 12000), { reasoning: { max_tokens: 116000, exclude: true }, maxTokens: 128000, effort: 'xhigh' });
  assert.equal(planReasoning(GROK, 'provider', 12000).reasoning, undefined);
  assert.equal(planReasoning(GROK, 'provider', 12000).maxTokens, 12000);
  // Anthropic's 1024-token thinking floor still leaves room for a tiny answer.
  assert.equal(planReasoning(SONNET, 'low', 64).maxTokens, 1088);
});

test('lowest effort for transcription models', () => {
  assert.equal(lowestEffort('google/gemini-3.1-flash-lite'), 'none');
  assert.equal(lowestEffort('google/gemini-3.5-flash-lite'), 'minimal');
  assert.equal(lowestEffort('mistralai/voxtral-small-24b-2507'), null);
});

const reply = (content, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }] });
function seq(responses, calls) {
  return async (url, init) => {
    calls.push(JSON.parse(init.body));
    const r = responses.shift();
    return new Response(JSON.stringify(r.body), { status: r.status || 200 });
  };
}

test('chatJSON sends reasoning + throughput routing', async () => {
  const calls = [];
  const res = await chatJSON({ apiKey: 'k', model: SONNET, messages: [], reasoningEffort: 'high', fetchImpl: seq([{ body: reply('{}') }], calls) });
  assert.deepEqual(calls[0].reasoning, { effort: 'high', exclude: true });
  assert.deepEqual(calls[0].provider, { sort: 'throughput' });
  assert.equal(calls[0].max_tokens, 60000);
  assert.equal(res.effort, 'high');
});

test('chatJSON retries without reasoning when rejected', async () => {
  const calls = [];
  const res = await chatJSON({ apiKey: 'k', model: GROK, messages: [], fetchImpl: seq([{ status: 400, body: { error: { message: 'reasoning effort not supported' } } }, { body: reply('{}') }], calls) });
  assert.equal('reasoning' in calls[1], false);
  assert.equal(calls[1].max_tokens, 12000);
  assert.equal(res.notes.length, 1);
});

test('chatJSON retries at the lowest level when thinking eats the budget', async () => {
  const calls = [];
  const res = await chatJSON({ apiKey: 'k', model: SONNET, messages: [], reasoningEffort: 'high', fetchImpl: seq([{ body: reply('', 'length') }, { body: reply('{"a":1}') }], calls) });
  assert.equal(calls[1].reasoning.effort, 'low');
  assert.equal(res.effort, 'low');
  assert.match(res.notes[0], /retried at "low"/);
});

test('transcription sends the lowest reasoning level', async () => {
  const calls = [];
  await transcribeAudio({ apiKey: 'k', model: DEFAULT_STT_MODEL, wavBase64: 'UklGR', fetchImpl: seq([{ body: reply('hi') }], calls) });
  assert.deepEqual(calls[0].reasoning, { effort: 'none' });
  await transcribeAudio({ apiKey: 'k', model: 'openai/gpt-audio-mini', wavBase64: 'UklGR', fetchImpl: seq([{ body: reply('hi') }], calls) });
  assert.equal('reasoning' in calls[1], false);
});

test('settings migrate old defaults once, keep explicit choices', () => {
  const old = normalizeSettings({ model: 'deepseek/deepseek-v4-flash', sttModel: 'google/gemini-3.5-flash-lite' });
  assert.equal(old.model, SONNET);
  assert.equal(old.sttModel, DEFAULT_STT_MODEL);
  assert.equal(old.settingsVersion, 2);
  // After migration the user may pick the old ids on purpose.
  const chosen = normalizeSettings({ model: 'deepseek/deepseek-v4-flash', sttModel: 'google/gemini-3.5-flash-lite', settingsVersion: 2 });
  assert.equal(chosen.model, 'deepseek/deepseek-v4-flash');
  assert.equal(chosen.sttModel, 'google/gemini-3.5-flash-lite');
  assert.equal(normalizeSettings({ model: 'x-ai/grok-4.7' }).model, GROK);
  assert.equal(normalizeSettings({ reasoningEffort: 'turbo' }).reasoningEffort, 'auto');
  assert.equal(normalizeSettings({ reasoningEffort: 'xhigh' }).reasoningEffort, 'xhigh');
});
