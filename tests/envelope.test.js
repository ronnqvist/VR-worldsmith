import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, buildMessages, extractJsonObject } from '../src/llm/envelope.js';
import { buildSystemPrompt } from '../src/llm/systemPrompt.js';

const ok = { action: 'create_world', markup: '<a-box id="b"></a-box>', removed_ids: [], narration: 'A box appears.' };

test('parses plain JSON', () => {
  assert.deepEqual(parseEnvelope(JSON.stringify(ok)), ok);
});

test('strips code fences and think blocks', () => {
  const txt = '<think>hmm {"x":1}</think>```json\n' + JSON.stringify(ok) + '\n```';
  assert.equal(parseEnvelope(txt).action, 'create_world');
});

test('extracts JSON after prose, braces inside strings', () => {
  const env = { ...ok, narration: 'Curly } braces { inside' };
  const txt = 'Sure! Here you go: ' + JSON.stringify(env) + ' Enjoy.';
  assert.equal(parseEnvelope(txt).narration, 'Curly } braces { inside');
  assert.equal(extractJsonObject('no json'), null);
});

test('rejects bad action, missing markup, non-JSON', () => {
  assert.throws(() => parseEnvelope(JSON.stringify({ ...ok, action: 'delete_everything' })), /unknown action/);
  assert.throws(() => parseEnvelope(JSON.stringify({ action: 'update_world' })), /no markup/);
  assert.throws(() => parseEnvelope('not json at all'), /not valid JSON/);
  assert.throws(() => parseEnvelope(''), /empty reply/);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...ok, markup: '  ' })), /empty world/);
});

test('normalises removed_ids and narration', () => {
  const env = parseEnvelope(JSON.stringify({ action: 'update_world', markup: '', removed_ids: ['ok-id', 5, '<bad>', '1bad'], narration: 'Hi <b>there</b>\n' }));
  assert.deepEqual(env.removed_ids, ['ok-id']);
  assert.equal(env.narration, 'Hi b there /b');
  const env2 = parseEnvelope(JSON.stringify({ action: 'update_world', markup: '', removed_ids: 'x' }));
  assert.deepEqual(env2.removed_ids, []);
});

test('buildMessages includes world, mode and recent exchanges', () => {
  const msgs = buildMessages({
    systemPrompt: buildSystemPrompt('ar'),
    prompt: 'add a cat',
    world: { text: '<a-box id="b"></a-box>', truncated: false, entities: 1 },
    recent: [{ prompt: 'make a box', narration: 'Box.' }],
    mode: 'ar'
  });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /MIXED REALITY/);
  assert.doesNotMatch(msgs[0].content, /\{\{MODE_RULES\}\}/);
  assert.equal(msgs.length, 4);
  assert.match(msgs.at(-1).content, /CURRENT WORLD \(1 elements\)/);
  assert.match(msgs.at(-1).content, /REQUEST: add a cat/);
  const empty = buildMessages({ systemPrompt: 's', prompt: 'p', world: { text: '', entities: 0 } });
  assert.match(empty.at(-1).content, /empty/);
});
