import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatJSON, validateKey, mapHttpError, looksLikeKey } from '../src/llm/openrouter.js';

function mockFetch(responses, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200, headers: r.headers || {} });
  };
}
const completion = (content, finish = 'stop') => ({ body: { model: 'm', choices: [{ message: { content }, finish_reason: finish }], usage: { total_tokens: 3 } } });

test('sends key only to openrouter with json_object and optional headers', async () => {
  const calls = [];
  const res = await chatJSON({ apiKey: 'sk-or-v1-abcdefghijkl', model: 'x/y', messages: [], referer: 'https://a.b/', title: 'Wörldsmith', fetchImpl: mockFetch([completion('{"a":1}')], calls) });
  assert.equal(res.content, '{"a":1}');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  const h = calls[0].init.headers;
  assert.equal(h.Authorization, 'Bearer sk-or-v1-abcdefghijkl');
  assert.equal(h['HTTP-Referer'], 'https://a.b/');
  assert.equal(h['X-Title'], 'Wrldsmith');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.stream, false);
  assert.equal(calls[0].init.credentials, 'omit');
});

test('omits blank optional headers', async () => {
  const calls = [];
  await chatJSON({ apiKey: 'k', model: 'm', messages: [], referer: '', title: '', fetchImpl: mockFetch([completion('{}')], calls) });
  assert.equal('HTTP-Referer' in calls[0].init.headers, false);
  assert.equal('X-Title' in calls[0].init.headers, false);
});

test('retries once on 429 honouring Retry-After, then succeeds', async () => {
  const calls = [];
  const res = await chatJSON({ apiKey: 'k', model: 'm', messages: [], fetchImpl: mockFetch([{ status: 429, body: {}, headers: { 'retry-after': '0' } }, completion('{}')], calls) });
  assert.equal(calls.length, 2);
  assert.equal(res.content, '{}');
});

test('gives up after one retry on 5xx', async () => {
  await assert.rejects(
    chatJSON({ apiKey: 'k', model: 'm', messages: [], fetchImpl: mockFetch([{ status: 503, body: {}, headers: { 'retry-after': '0' } }, { status: 503, body: {}, headers: { 'retry-after': '0' } }]) }),
    /provider is unavailable/
  );
});

test('401 is not retried and maps to key message', async () => {
  const calls = [];
  await assert.rejects(chatJSON({ apiKey: 'k', model: 'm', messages: [], fetchImpl: mockFetch([{ status: 401, body: { error: { message: 'No auth' } } }], calls) }), /rejected your key/);
  assert.equal(calls.length, 1);
});

test('falls back when response_format unsupported', async () => {
  const calls = [];
  const res = await chatJSON({ apiKey: 'k', model: 'm', messages: [], fetchImpl: mockFetch([{ status: 400, body: { error: { message: 'response_format is not supported' } } }, completion('{}')], calls) });
  assert.equal(res.content, '{}');
  assert.equal('response_format' in JSON.parse(calls[1].init.body), false);
});

test('length finish and 200-with-error are errors', async () => {
  await assert.rejects(chatJSON({ apiKey: 'k', model: 'm', messages: [], fetchImpl: mockFetch([completion('{"a":', 'length')]) }), /ran out of output tokens/);
  await assert.rejects(chatJSON({ apiKey: 'k', model: 'm', messages: [], fetchImpl: mockFetch([{ body: { error: { code: 502, message: 'upstream' } } }]) }), /unavailable/);
});

test('missing key / model', async () => {
  await assert.rejects(chatJSON({ apiKey: '', model: 'm', messages: [] }), /API key/);
  await assert.rejects(chatJSON({ apiKey: 'k', model: '', messages: [] }), /model/);
});

test('validateKey checks /key then the model', async () => {
  const calls = [];
  const r = await validateKey({ apiKey: 'k', model: 'm', fetchImpl: mockFetch([{ body: { data: { label: 'L', limit_remaining: 4.2, usage: 1 } } }, completion('{"ok":true}')], calls) });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(r.key.label, 'L');
  assert.equal(r.model.ok, true);
  await assert.rejects(validateKey({ apiKey: 'k', model: 'm', fetchImpl: mockFetch([{ status: 401, body: {} }]) }), /rejected your key/);
});

test('misc helpers', () => {
  assert.equal(looksLikeKey('sk-or-v1-0123456789abcdef'), true);
  assert.equal(looksLikeKey('hello'), false);
  assert.equal(mapHttpError(402, {}).code, 'credits');
  assert.equal(mapHttpError(404, {}).code, 'model');
});
